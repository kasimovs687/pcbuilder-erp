/**
 * Первичное наполнение БД: каталог комплектующих, сотрудники, демо-клиент, демо-заказы.
 * Запускается при каждом старте; каталог каждый раз сверяется с data.js (см. lib/catalog.js),
 * остальное наполняется только если данных ещё нет.
 */
const db = require('./db');
const U = require('./util');
const auth = require('./auth');
const settings = require('./settings');
const catalog = require('./catalog');
const cfg = require('../config');
const crypto = require('crypto');

const stamp = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

async function rememberStamp(key, password) {
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, stamp(password), U.now()]
  );
}

/**
 * Приводит пароль стартового аккаунта к значению из secrets.local.json.
 * Хеш перезаписывается только когда пароль в конфигурации действительно изменился —
 * смена пароля через интерфейс не откатывается при следующем запуске.
 */
async function syncPassword(table, column, login, password, markerKey) {
  if (!password || !login) return;
  const row = await db.get(`SELECT id, password_hash FROM ${table} WHERE ${column} = ?`, [login]);
  if (!row) return;
  if (auth.verifyPassword(password, row.password_hash)) {
    await rememberStamp(markerKey, password);
    return;
  }
  const marker = await db.get('SELECT value FROM settings WHERE key = ?', [markerKey]);
  if (marker && marker.value === stamp(password)) return;
  await db.run(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [auth.hashPassword(password), row.id]);
  await rememberStamp(markerKey, password);
}

/**
 * Гарантирует наличие стартового сотрудника с нужным логином и паролем.
 * Если аккаунта нет — создаёт; если есть — синхронизирует пароль.
 */
async function ensureStaff(login, password, fullName, role, phone, markerKey) {
  if (!login || !password) return;
  const row = await db.get('SELECT id FROM staff WHERE login = ?', [login]);
  if (!row) {
    await db.run(
      `INSERT INTO staff (login, password_hash, full_name, role, phone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [login, auth.hashPassword(password), fullName, role, phone, U.now()]
    );
    await rememberStamp(markerKey, password);
    return;
  }
  await syncPassword('staff', 'login', login, password, markerKey);
}

/** Логины из прежних версий: их пароли были общедоступны, поэтому аккаунты переименовываются. */
const LEGACY_STAFF = { sbolschik: 'assembler' };

async function migrateLegacyStaff() {
  for (const [legacyLogin, newLogin] of Object.entries(LEGACY_STAFF)) {
    if (legacyLogin === newLogin) continue;
    const legacy = await db.get('SELECT id FROM staff WHERE login = ?', [legacyLogin]);
    if (!legacy) continue;
    const clash = await db.get('SELECT id FROM staff WHERE login = ?', [newLogin]);
    if (clash) await db.run('DELETE FROM staff WHERE id = ?', [legacy.id]);
    else await db.run('UPDATE staff SET login = ? WHERE id = ?', [newLogin, legacy.id]);
  }
}

async function seedStaff() {
  await migrateLegacyStaff();
  await ensureStaff(cfg.seed.adminLogin, cfg.seed.adminPassword, 'Администратор', 'admin', cfg.company.phone, 'seed.admin.password');
  await ensureStaff(cfg.seed.assemblerLogin, cfg.seed.assemblerPassword, 'Сборщик ПК', 'assembler', '+7 (999) 000-00-01', 'seed.assembler.password');
}

/** Синхронизация каталога: обновляет названия, цены и характеристики из data.js. */
async function seedComponents() {
  return catalog.syncCatalog();
}

async function seedDemoClient() {
  const count = await db.get('SELECT COUNT(*) AS c FROM clients');
  if (count.c > 0) {
    await syncPassword('clients', 'phone', cfg.seed.demoClientPhone, cfg.seed.demoClientPassword, 'seed.client.password');
    return;
  }
  await db.run(
    `INSERT INTO clients (full_name, phone, email, password_hash, city, address, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'Демо Клиент', cfg.seed.demoClientPhone, 'demo@pcbuild.ru',
      auth.hashPassword(cfg.seed.demoClientPassword),
      'Москва', 'ул. Тверская, 7, кв 15',
      'Демо-аккаунт для тестирования',
      U.now(),
    ]
  );
  await rememberStamp('seed.client.password', cfg.seed.demoClientPassword);

  // Демо-заказы для клиента
  const client = await db.get('SELECT id FROM clients WHERE phone = ?', [cfg.seed.demoClientPhone]);
  if (!client) return;

  const comps = await db.all('SELECT * FROM components ORDER BY category, price');
  const findCat = (cat) => {
    const list = comps.filter((c) => c.category === cat);
    return list[0];
  };

  const cpu = findCat('CPU');
  const gpu = findCat('GPU');
  const mb = findCat('Motherboard');
  const ram = findCat('RAM');
  const psu = findCat('PSU');
  const pcCase = findCat('Case');
  const storage = findCat('Storage');
  const cooler = findCat('Cooler');

  // Заказ 1 — оплачен, в сборке
  const fees = await settings.fees();
  if (cpu && gpu && mb && ram && psu) {
    const items1 = [cpu, mb, ram, gpu, psu].filter(Boolean);
    const parts1 = items1.reduce((s, c) => s + U.num(c.price), 0);
    const total1 = parts1 + fees.assembly + fees.delivery.courier;
    const r1 = await db.run(
      `INSERT INTO orders (order_no, client_id, status, payment_status, payment_method, delivery_type,
        city, address, recipient, recipient_phone, parts_total, assembly_fee, delivery_cost, total, comment, created_at, paid_at, updated_at)
       VALUES (?, ?, 'assembling', 'paid', 'card', 'courier', 'Москва', 'ул. Тверская, 7, кв 15', 'Демо Клиент', '+79990000000',
        ?, ?, ?, ?, 'Нужна тихая сборка', ?, ?, ?)`,
      [U.genOrderNo(), client.id, U.money(parts1), U.money(fees.assembly), U.money(fees.delivery.courier),
       U.money(total1), U.now(), U.now(), U.now()]
    );
    for (const c of items1) {
      const st = U.num(c.stock) - U.num(c.reserved) >= 1 ? 'reserved' : 'ordered';
      await db.run(
        'INSERT INTO order_items (order_id, component_id, category, name, price, qty, status) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [r1.insertId, c.id, c.category, c.name, U.money(c.price), st]
      );
    }
    await U.addEvent(r1.insertId, 'system', 'created', 'Демо-заказ создан');
    await U.addEvent(r1.insertId, 'client', 'payment', 'Оплата 12800 ₽ (карта)');
    await U.addEvent(r1.insertId, 'staff', 'status', 'Заказ переведён в сборку');
  }

  // Заказ 2 — новый, не оплачен
  if (storage && cooler && pcCase) {
    const items2 = [storage, cooler, pcCase].filter(Boolean);
    const parts2 = items2.reduce((s, c) => s + U.num(c.price), 0);
    const total2 = parts2 + fees.assembly + fees.delivery.cdek;
    const r2 = await db.run(
      `INSERT INTO orders (order_no, client_id, status, payment_status, payment_method, delivery_type,
        city, address, recipient, recipient_phone, parts_total, assembly_fee, delivery_cost, total, comment, created_at, updated_at)
       VALUES (?, ?, 'new', 'unpaid', 'sbp', 'cdek', 'Москва', 'ул. Тверская, 7, кв 15', 'Демо Клиент', '+79990000000',
        ?, ?, ?, ?, '', ?, ?)`,
      [U.genOrderNo(), client.id, U.money(parts2), U.money(fees.assembly), U.money(fees.delivery.cdek),
       U.money(total2), U.now(), U.now()]
    );
    for (const c of items2) {
      await db.run(
        'INSERT INTO order_items (order_id, component_id, category, name, price, qty, status) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [r2.insertId, c.id, c.category, c.name, U.money(c.price), 'ordered']
      );
    }
    await U.addEvent(r2.insertId, 'system', 'created', 'Демо-заказ создан, ожидает оплаты');
  }
}

async function seedAll() {
  await seedStaff();
  const catalog = await seedComponents();
  await seedDemoClient();
  return catalog;
}

module.exports = { seedAll };