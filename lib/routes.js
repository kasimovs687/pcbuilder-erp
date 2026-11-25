/** HTTP API: auth, каталог, заказы, оплата, склад/приёмка, логистика, клиенты, статистика. */
const httpLayer = require('./http');
const db = require('./db');
const cfg = require('../config');
const auth = require('./auth');
const settings = require('./settings');
const catalog = require('./catalog');
const builder = require('./builder');
const sms = require('./sms');
const U = require('./util');
const C = require('./constants');
const orders = require('./orders');

const router = httpLayer.createApp();
const startedAt = Date.now();

const ORDER_SELECT = `
  SELECT o.*, c.full_name AS client_name, c.phone AS client_phone,
         s.full_name AS assembler_name,
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS items_count,
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status = 'received') AS items_received,
         (SELECT COUNT(*) FROM order_messages m WHERE m.order_id = o.id) AS messages_count,
         (SELECT MAX(m.created_at) FROM order_messages m WHERE m.order_id = o.id) AS last_message_at,
         (SELECT COUNT(*) FROM order_messages m WHERE m.order_id = o.id AND m.author_type = 'client'
            AND m.created_at > COALESCE((SELECT MAX(m2.created_at) FROM order_messages m2
                                          WHERE m2.order_id = o.id AND m2.author_type = 'staff'), '')) AS client_unread
  FROM orders o
  LEFT JOIN clients c ON c.id = o.client_id
  LEFT JOIN staff s ON s.id = o.assembler_id
`;

const numFields = ['parts_total', 'assembly_fee', 'delivery_cost', 'total'];
const cleanOrderRow = (r) => {
  if (!r) return r;
  const out = { ...r };
  for (const f of numFields) out[f] = U.num(out[f]);
  out.items_count = U.num(out.items_count);
  out.items_received = U.num(out.items_received);
  out.messages_count = U.num(out.messages_count);
  out.client_unread = U.num(out.client_unread);
  return out;
};

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ============================ META ============================ */
router.get('/meta', asyncRoute(async (_req, res) => {
  res.json({
    statuses: C.ORDER_STATUSES,
    kanban: C.KANBAN,
    flow: C.STATUS_FLOW,
    paymentStatuses: C.PAYMENT_STATUSES,
    paymentMethods: C.PAYMENT_METHODS,
    deliveryTypes: C.DELIVERY_TYPES,
    shipmentStatuses: C.SHIPMENT_STATUSES,
    shipmentFlow: C.SHIPMENT_FLOW,
    orderStages: C.ORDER_STAGES,
    itemStatuses: C.ITEM_STATUS,
    carriers: C.CARRIERS,
    fees: await settings.fees(),
    profiles: builder.publicProfiles(),
    categories: catalog.loadSource().CATEGORY_LIST,
    catalogSize: await db.get('SELECT COUNT(*) AS c FROM components WHERE archived = 0'),
    company: await settings.publicMeta(),
    dbDriver: db.driver(),
  });
}));

/* ============================ HEALTH ============================ */
/** Состояние системы: БД, количество записей, целостность, аптайм. */
router.get('/health', asyncRoute(async (_req, res) => {
  const tables = ['clients', 'staff', 'components', 'orders', 'order_items', 'payments', 'shipments', 'supplies', 'order_messages'];
  const counts = {};
  for (const t of tables) counts[t] = await db.count(t);
  const health = await db.check();
  res.json({
    ok: health.ok,
    driver: db.driver(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.versions.node,
    tables: db.tableNames(),
    counts,
    integrity: health.integrity,
    foreignKeyErrors: health.foreignKeys,
  });
}));

/* ============================ НАСТРОЙКИ ============================ */
/** Публичная часть реквизитов — для подвалов, писем и печатных форм. */
router.get('/settings', auth.requireStaff, asyncRoute(async (_req, res) => {
  res.json({
    company: await settings.publicMeta(),
    requisites: await settings.company(),
    fees: await settings.fees(),
    values: await settings.masked(),
  });
}));

/** Изменение реквизитов и тарифов (только сотрудник). Принимаются только известные ключи. */
router.patch('/settings', auth.requireStaff, asyncRoute(async (req, res) => {
  const changed = await settings.set(req.body || {});
  res.json({ ok: true, changed, settings: await settings.masked() });
}));

/* ============================ ЛЕНТА СОБЫТИЙ ============================ */
/** Последние действия по заказам — для «колокольчика» в шапке панели сборщика. */
router.get('/activity', auth.requireStaff, asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 50);
  const rows = await db.all(
    `SELECT e.id, e.order_id, e.actor, e.kind, e.message, e.created_at, o.order_no, o.status
       FROM order_events e
       LEFT JOIN orders o ON o.id = e.order_id
      ORDER BY e.id DESC LIMIT ?`,
    [limit]
  );
  res.json(rows);
}));

/* ============================ AUTH ============================ */
router.post('/auth/register', asyncRoute(async (req, res) => {
  const { fullName, phone, email, password, city, address } = req.body || {};
  if (!fullName || !phone || !password) return res.status(400).json({ error: 'Укажите имя, телефон и пароль' });
  const exists = await db.get('SELECT id FROM clients WHERE phone = ?', [phone]);
  if (exists) return res.status(409).json({ error: 'Клиент с таким телефоном уже зарегистрирован' });
  const r = await db.run(
    `INSERT INTO clients (full_name, phone, email, password_hash, city, address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fullName, phone, email || null, auth.hashPassword(password), city || '', address || '', U.now()]
  );
  await auth.createSession(res, 'client', r.insertId);
  const user = await db.get('SELECT id, full_name, phone, email, city, address, sms_opt_in FROM clients WHERE id = ?', [r.insertId]);
  res.json({ ok: true, user: { type: 'client', name: user.full_name, ...user } });
}));

router.post('/auth/login', asyncRoute(async (req, res) => {
  const { login, password, role } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  const value = String(login).trim();

  if (role === 'staff') {
    const u = await db.get('SELECT * FROM staff WHERE login = ?', [value]);
    if (!u || !auth.verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: 'Неверный логин или пароль сотрудника' });
    }
    await auth.createSession(res, 'staff', u.id);
    return res.json({ ok: true, user: { type: 'staff', id: u.id, name: u.full_name, login: u.login, role: u.role } });
  }

  const u = await db.get('SELECT * FROM clients WHERE phone = ? OR email = ?', [value, value]);
  if (!u || !auth.verifyPassword(password, u.password_hash)) {
    return res.status(401).json({ error: 'Неверный телефон/email или пароль' });
  }
  await auth.createSession(res, 'client', u.id);
  return res.json({
    ok: true,
    user: {
      type: 'client', id: u.id, name: u.full_name, phone: u.phone, email: u.email,
      city: u.city, address: u.address, sms_opt_in: U.num(u.sms_opt_in),
    },
  });
}));

router.post('/auth/logout', asyncRoute(async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

router.get('/auth/me', asyncRoute(async (req, res) => {
  if (!req.user) return res.json({ user: null, dbDriver: db.driver() });
  if (req.user.type === 'client') {
    const row = await db.get('SELECT id, full_name, phone, email, city, address, sms_opt_in FROM clients WHERE id = ?', [req.user.id]);
    return res.json({ user: { type: 'client', ...row, name: row.full_name, sms_opt_in: U.num(row.sms_opt_in) }, dbDriver: db.driver() });
  }
  res.json({ user: req.user, dbDriver: db.driver() });
}));

router.patch('/me', auth.requireClient, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const map = { fullName: 'full_name', phone: 'phone', email: 'email', city: 'city', address: 'address' };
  const sets = [];
  const p = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); p.push(b[k]); }
  }
  // Отписка от SMS-уведомлений
  if (b.smsOptIn !== undefined) { sets.push('sms_opt_in = ?'); p.push(b.smsOptIn ? 1 : 0); }

  // Смена пароля: только при верном текущем
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'Новый пароль — минимум 6 символов' });
    const row = await db.get('SELECT password_hash FROM clients WHERE id = ?', [req.user.id]);
    if (!auth.verifyPassword(b.currentPassword || '', row.password_hash)) {
      return res.status(400).json({ error: 'Текущий пароль указан неверно' });
    }
    sets.push('password_hash = ?');
    p.push(auth.hashPassword(b.password));
  }

  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });

  // Телефон уникален — проверим до записи
  if (b.phone !== undefined) {
    const dup = await db.get('SELECT id FROM clients WHERE phone = ? AND id <> ?', [b.phone, req.user.id]);
    if (dup) return res.status(409).json({ error: 'Этот телефон уже закреплён за другим клиентом' });
  }

  p.push(req.user.id);
  await db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, p);
  const u = await db.get('SELECT id, full_name, phone, email, city, address, sms_opt_in FROM clients WHERE id = ?', [req.user.id]);
  res.json({ ok: true, user: { type: 'client', id: u.id, name: u.full_name, ...u, sms_opt_in: U.num(u.sms_opt_in) } });
}));

/* ============================ КАТАЛОГ ============================ */
/** Полный каталог для конфигуратора: названия, цены и все характеристики. */
router.get('/catalog', asyncRoute(async (req, res) => {
  const { category, q } = req.query;
  const list = category
    ? await catalog.byCategory(String(category))
    : await catalog.all();
  const filtered = q
    ? list.filter((c) => c.Name.toLowerCase().includes(String(q).toLowerCase()))
    : list;
  res.json(filtered);
}));

router.get('/components', asyncRoute(async (req, res) => {
  const { category, q, limit } = req.query;
  let sql = `SELECT id, source_id, category, name, description, image, price, socket, ram_type, tdp, wattage,
                    performance_index, stock, reserved, min_stock, brand, cores, threads, memory_gb,
                    capacity_gb, form_factor, interface, efficiency, tags, specs, archived, updated_at
               FROM components WHERE archived = 0`;
  const p = [];
  if (category) { sql += ' AND category = ?'; p.push(category); }
  if (q) { sql += ' AND name LIKE ?'; p.push(`%${q}%`); }
  sql += ' ORDER BY category, price';
  if (limit) { sql += ' LIMIT ?'; p.push(Number(limit)); }
  const rows = await db.all(sql, p);
  res.json(rows.map((r) => ({
    ...r, price: U.num(r.price), stock: U.num(r.stock), reserved: U.num(r.reserved), min_stock: U.num(r.min_stock),
  })));
}));

router.post('/components', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.category) return res.status(400).json({ error: 'Укажите категорию и название' });
  const r = await db.run(
    `INSERT INTO components (category, name, description, image, price, socket, ram_type, tdp, wattage, performance_index, stock, min_stock, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.category, b.name, b.description || '', b.image || '', U.money(b.price || 0), b.socket || null,
      b.ramType || null, b.tdp ?? null, b.wattage ?? null, b.performanceIndex ?? null,
      U.num(b.stock || 0), U.num(b.minStock ?? 3), U.now()]
  );
  res.json({ ok: true, id: r.insertId });
}));

router.patch('/components/:id', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const allowed = { name: 'name', price: 'price', stock: 'stock', minStock: 'min_stock', description: 'description' };
  const sets = [];
  const p = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (b[key] !== undefined) {
      sets.push(`${col} = ?`);
      p.push(col === 'price' ? U.money(b[key]) : U.num(b[key]));
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  p.push(req.params.id);
  await db.run(`UPDATE components SET ${sets.join(', ')} WHERE id = ?`, p);
  res.json({ ok: true });
}));

router.post('/components/:id/stock', auth.requireStaff, asyncRoute(async (req, res) => {
  const delta = U.num(req.body?.delta);
  await db.run(
    'UPDATE components SET stock = CASE WHEN stock + ? < 0 THEN 0 ELSE stock + ? END WHERE id = ?',
    [delta, delta, req.params.id]
  );
  res.json({ ok: true });
}));

/* =================== СБОРКА В 1 КЛИК (КЛИЕНТ) =================== */
/** Сценарии использования: офис, игры, монтаж, 3D, стрим, универсальный. */
router.get('/profiles', asyncRoute(async (_req, res) => {
  res.json({
    profiles: builder.publicProfiles(),
    categories: catalog.loadSource().CATEGORY_LIST,
  });
}));

/**
 * Подбор готовой сборки: GET /api/quick-build?budget=130000&profile=gaming&delivery=courier
 * Тело запроса (POST) имеет приоритет — так удобнее из интерфейса.
 */
const quickBuildHandler = asyncRoute(async (req, res) => {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  const result = await builder.quickBuild({
    budget: q.budget,
    profile: q.profile || 'gaming',
    delivery: q.delivery || 'courier',
  });
  if (!result.ok) return res.status(422).json(result);
  res.json(result);
});
router.get('/quick-build', quickBuildHandler);
router.post('/quick-build', quickBuildHandler);

/* ================== SMS-УВЕДОМЛЕНИЯ КЛИЕНТУ ================== */
/** Журнал уведомлений + состояние канала (панель сборщика → SMS). */
router.get('/sms', auth.requireStaff, asyncRoute(async (req, res) => {
  const { status, orderId, limit } = req.query;
  res.json({
    rows: await sms.history({ status: status || '', orderId: orderId ? Number(orderId) : null, limit: limit || 120 }),
    stats: await sms.stats(),
    events: sms.EVENTS,
    placeholders: sms.PLACEHOLDERS,
    providers: [
      { id: 'log', title: 'Журнал (без отправки)', hint: 'Тексты пишутся в data/sms.log и в журнал — ничего не уходит наружу' },
      { id: 'smsc', title: 'SMSC.ru', hint: 'Реальная отправка: api_id, логин и пароль из личного кабинета SMSC' },
      { id: 'webhook', title: 'Свой шлюз (webhook)', hint: 'POST { phone, text, orderNo, event } на ваш адрес' },
    ],
  });
}));

/** Ручная отправка: клиенту по заказу или произвольный текст на телефон. */
router.post('/sms/send', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (b.orderId) {
    const r = await sms.notifyOrder(Number(b.orderId), b.event || 'custom', { text: (b.text || '').trim() || undefined });
    return res.json(r);
  }
  if (!b.phone || !(b.text || '').trim()) return res.status(400).json({ error: 'Нужен телефон или заказ и текст' });
  const r = await sms.send({ phone: b.phone, event: 'custom', text: b.text.trim() });
  res.json(r);
}));

/** Тестовое сообщение на свой номер — проверяем канал перед боевым запуском. */
router.post('/sms/test', auth.requireStaff, asyncRoute(async (req, res) => {
  const r = await sms.test((req.body || {}).phone);
  res.json(r);
}));

/* ============================ ЗАКАЗЫ: КЛИЕНТ ============================ */
router.post('/orders', asyncRoute(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
  const b = req.body || {};
  // Сборщик может оформить заказ от имени клиента (заказ по телефону / в мастерской)
  let clientId = req.user.id;
  if (req.user.type === 'staff') {
    if (!b.clientId) return res.status(400).json({ error: 'Укажите клиента для заказа' });
    clientId = Number(b.clientId);
  }
  const clientRow = await db.get('SELECT id, full_name, phone, city, address FROM clients WHERE id = ?', [clientId]);
  if (!clientRow) return res.status(404).json({ error: 'Клиент не найден' });
  const data = await orders.createOrder({
    clientId,
    items: b.items || [],
    deliveryType: b.deliveryType || 'courier',
    city: b.city || clientRow.city || '',
    address: b.address || clientRow.address || '',
    recipient: b.recipient || clientRow.full_name || '',
    recipientPhone: b.recipientPhone || clientRow.phone || '',
    paymentMethod: b.paymentMethod || 'card',
    comment: b.comment || '',
  });
  res.json(orders.serialize(data));
}));

router.get('/orders/my', auth.requireClient, asyncRoute(async (req, res) => {
  const rows = await db.all(`${ORDER_SELECT} WHERE o.client_id = ? ORDER BY o.id DESC`, [req.user.id]);
  res.json(rows.map(cleanOrderRow));
}));

/* ============================ ЗАКАЗЫ: СОТРУДНИК ============================ */
router.get('/orders', auth.requireStaff, asyncRoute(async (req, res) => {
  const { status, q, clientId, limit } = req.query;
  let sql = `${ORDER_SELECT} WHERE 1=1`;
  const p = [];
  if (status) {
    const list = String(status).split(',').filter(Boolean);
    sql += ` AND o.status IN (${list.map(() => '?').join(',')})`;
    p.push(...list);
  }
  if (clientId) { sql += ' AND o.client_id = ?'; p.push(clientId); }
  if (q) {
    sql += ' AND (o.order_no LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ?)';
    p.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY o.id DESC';
  if (limit) { sql += ' LIMIT ?'; p.push(Number(limit)); }
  const rows = await db.all(sql, p);
  res.json(rows.map(cleanOrderRow));
}));

async function getOrderFor(req, res) {
  const data = await orders.fetchOrder(req.params.id);
  if (!data) { res.status(404).json({ error: 'Заказ не найден' }); return null; }
  const isOwner = req.user && req.user.type === 'client' && data.order.client_id === req.user.id;
  const isStaff = req.user && req.user.type === 'staff';
  if (!isOwner && !isStaff) { res.status(403).json({ error: 'Нет доступа к заказу' }); return null; }
  return data;
}

router.get('/orders/:id', asyncRoute(async (req, res) => {
  const data = await getOrderFor(req, res);
  if (!data) return;
  res.json(orders.serialize(data));
}));

/* ---- Переписка по заказу: клиент ↔ сборщик ---- */
router.get('/orders/:id/messages', asyncRoute(async (req, res) => {
  const data = await getOrderFor(req, res);
  if (!data) return;
  res.json(await db.all('SELECT * FROM order_messages WHERE order_id = ? ORDER BY id', [data.order.id]));
}));

router.post('/orders/:id/messages', asyncRoute(async (req, res) => {
  const data = await getOrderFor(req, res);
  if (!data) return;
  const text = String(req.body?.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  await db.run(
    'INSERT INTO order_messages (order_id, author_type, author_name, message, created_at) VALUES (?, ?, ?, ?, ?)',
    [data.order.id, req.user.type, req.user.name || '', text, U.now()]
  );
  await U.addEvent(data.order.id, req.user.type, 'message',
    `Сообщение (${req.user.type === 'client' ? 'клиент' : 'сборщик'}): ${text.slice(0, 60)}`);
  res.json(await db.all('SELECT * FROM order_messages WHERE order_id = ? ORDER BY id', [data.order.id]));
}));

router.patch('/orders/:id/status', auth.requireStaff, asyncRoute(async (req, res) => {
  const { status, note, force } = req.body || {};
  const data = await orders.setStatus(req.params.id, status, 'staff', note || '', !!force);
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/assign', auth.requireStaff, asyncRoute(async (req, res) => {
  const { assemblerId } = req.body || {};
  await db.run('UPDATE orders SET assembler_id = ?, updated_at = ? WHERE id = ?',
    [assemblerId || null, U.now(), req.params.id]);
  const who = assemblerId ? await db.get('SELECT full_name FROM staff WHERE id = ?', [assemblerId]) : null;
  await U.addEvent(req.params.id, 'staff', 'assign', who ? `Назначен сборщик: ${who.full_name}` : 'Сборщик снят с заказа');
  res.json(orders.serialize(await orders.fetchOrder(req.params.id)));
}));

router.post('/orders/:id/pay', auth.requireClient, asyncRoute(async (req, res) => {
  const { method } = req.body || {};
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o || o.client_id !== req.user.id) return res.status(404).json({ error: 'Заказ не найден' });
  if (o.payment_status === 'paid') return res.status(400).json({ error: 'Заказ уже оплачен' });
  const data = await orders.payOrder(o.id, method || 'card', 'client');
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/payment/confirm', auth.requireStaff, asyncRoute(async (req, res) => {
  const data = await orders.confirmPayment(req.params.id, 'staff', req.body?.ok !== false);
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/ship', auth.requireStaff, asyncRoute(async (req, res) => {
  const data = await orders.shipOrder(req.params.id, req.body || {}, 'staff');
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/tracking', auth.requireStaff, asyncRoute(async (req, res) => {
  const { status, location, note } = req.body || {};
  const data = await orders.addShipmentEvent(req.params.id, status || 'in_transit', location, note, 'staff');
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/confirm-receipt', auth.requireClient, asyncRoute(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o || o.client_id !== req.user.id) return res.status(404).json({ error: 'Заказ не найден' });
  const data = await orders.confirmReceipt(o.id, req.body?.code, 'client');
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/receipt-confirm-by-staff', auth.requireStaff, asyncRoute(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  await db.run('UPDATE orders SET delivered_at = ?, confirmed_at = ?, updated_at = ? WHERE id = ?',
    [U.now(), U.now(), U.now(), o.id]);
  await U.addEvent(o.id, 'staff', 'receipt', 'Получение подтверждено сборщиком (по звонку клиента)');
  const data = await orders.setStatus(o.id, 'delivered', 'staff', 'Получение подтверждено', true);
  res.json(orders.serialize(data));
}));

router.post('/orders/:id/cancel', asyncRoute(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  const isOwner = req.user && req.user.type === 'client' && o.client_id === req.user.id;
  if (!isOwner && !(req.user && req.user.type === 'staff')) return res.status(403).json({ error: 'Нет доступа' });
  const data = await orders.setStatus(o.id, 'cancelled', req.user.type === 'client' ? 'client' : 'staff', req.body?.reason || 'Отменён', true);
  res.json(orders.serialize(data));
}));

/* ============================ СКЛАД И ПРИЁМКА ============================ */
router.get('/supplies', auth.requireStaff, asyncRoute(async (_req, res) => {
  const rows = await db.all('SELECT * FROM supplies ORDER BY id DESC');
  const out = [];
  for (const s of rows) {
    const items = await db.all('SELECT * FROM supply_items WHERE supply_id = ?', [s.id]);
    out.push({ ...s, total: U.num(s.total), items: items.map((i) => ({ ...i, qty: U.num(i.qty), purchase_price: U.num(i.purchase_price) })) });
  }
  res.json(out);
}));

router.post('/supplies', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const total = items.reduce((s, i) => s + U.num(i.purchasePrice) * U.num(i.qty || 1), 0);
  const r = await db.run(
    `INSERT INTO supplies (supplier, invoice_no, order_id, status, total, comment, created_at)
     VALUES (?, ?, ?, 'in_transit', ?, ?, ?)`,
    [b.supplier || 'Поставщик', b.invoiceNo || null, b.orderId || null, U.money(total), b.comment || '', U.now()]
  );
  for (const i of items) {
    let name = i.name || '';
    if (!name && i.componentId) {
      const c = await db.get('SELECT name FROM components WHERE id = ?', [i.componentId]);
      name = c ? c.name : '';
    }
    await db.run(
      `INSERT INTO supply_items (supply_id, component_id, name, qty, purchase_price, order_item_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.insertId, i.componentId || null, name, U.num(i.qty || 1), U.money(i.purchasePrice || 0), i.orderItemId || null]
    );
  }
  if (b.orderId) await U.addEvent(b.orderId, 'staff', 'stock', `Создана поставка №${r.insertId} (${b.supplier || 'Поставщик'})`);
  res.json({ ok: true, id: r.insertId });
}));

router.post('/supplies/:id/receive', auth.requireStaff, asyncRoute(async (req, res) => {
  await orders.receiveSupply(req.params.id, 'staff');
  res.json({ ok: true });
}));

router.post('/order-items/:id/receive', auth.requireStaff, asyncRoute(async (req, res) => {
  const item = await db.get('SELECT * FROM order_items WHERE id = ?', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Позиция не найдена' });
  await db.run("UPDATE order_items SET status = 'received', received_at = ?, serial = ? WHERE id = ?",
    [U.now(), req.body?.serial || null, item.id]);
  if (item.component_id) {
    await db.run('UPDATE components SET stock = stock + ? WHERE id = ?', [U.num(item.qty), item.component_id]);
    await db.run(
      'UPDATE components SET reserved = CASE WHEN reserved - ? < 0 THEN 0 ELSE reserved - ? END WHERE id = ?',
      [U.num(item.qty), U.num(item.qty), item.component_id]
    );
  }
  await U.addEvent(item.order_id, 'staff', 'stock', `Получен компонент: ${item.name}`);
  res.json({ ok: true });
}));

/* ============================ КЛИЕНТЫ ============================ */
router.get('/clients', auth.requireStaff, asyncRoute(async (req, res) => {
  const q = req.query.q;
  let sql = `
    SELECT c.*,
      (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id) AS orders_count,
      (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.client_id = c.id) AS orders_sum
    FROM clients c WHERE 1=1`;
  const p = [];
  if (q) { sql += ' AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY c.id DESC';
  const rows = await db.all(sql, p);
  res.json(rows.map((r) => ({ ...r, orders_count: U.num(r.orders_count), orders_sum: U.num(r.orders_sum) })));
}));

router.get('/clients/:id', auth.requireStaff, asyncRoute(async (req, res) => {
  const client = await db.get('SELECT id, full_name, phone, email, city, address, note, created_at FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });
  const rows = await db.all(`${ORDER_SELECT} WHERE o.client_id = ? ORDER BY o.id DESC`, [client.id]);
  res.json({ client, orders: rows.map(cleanOrderRow) });
}));

router.post('/clients', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.phone || !b.fullName) return res.status(400).json({ error: 'Укажите имя и телефон' });
  if (!b.password || String(b.password).length < 6) {
    return res.status(400).json({ error: 'Задайте пароль клиента — минимум 6 символов' });
  }
  const exists = await db.get('SELECT id FROM clients WHERE phone = ?', [b.phone]);
  if (exists) return res.status(409).json({ error: 'Такой телефон уже есть в базе' });
  const r = await db.run(
    `INSERT INTO clients (full_name, phone, email, password_hash, city, address, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.fullName, b.phone, b.email || null, auth.hashPassword(b.password),
      b.city || '', b.address || '', b.note || '', U.now()]
  );
  res.json({ ok: true, id: r.insertId });
}));

router.patch('/clients/:id', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const map = { fullName: 'full_name', phone: 'phone', email: 'email', city: 'city', address: 'address', note: 'note' };
  const sets = [];
  const p = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); p.push(b[k]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  p.push(req.params.id);
  await db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, p);
  res.json({ ok: true });
}));

/* ============================ СОТРУДНИКИ ============================ */
router.get('/staff', auth.requireStaff, asyncRoute(async (_req, res) => {
  res.json(await db.all(
    `SELECT s.id, s.login, s.full_name, s.role, s.phone,
            (SELECT COUNT(*) FROM orders o WHERE o.assembler_id = s.id) AS orders_count,
            (SELECT COUNT(*) FROM orders o WHERE o.assembler_id = s.id AND o.status IN ('paid','purchasing','assembling','testing','ready')) AS wip
       FROM staff s ORDER BY s.id`
  ));
}));

/** Добавление сотрудника (только администратор). */
router.post('/staff', auth.requireStaff, asyncRoute(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Добавлять сотрудников может только администратор' });
  const b = req.body || {};
  const login = String(b.login || '').trim();
  if (!login || !b.password || !b.fullName) {
    return res.status(400).json({ error: 'Укажите логин, имя и пароль' });
  }
  if (String(b.password).length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const exists = await db.get('SELECT id FROM staff WHERE login = ?', [login]);
  if (exists) return res.status(409).json({ error: 'Такой логин уже занят' });
  const r = await db.run(
    `INSERT INTO staff (login, password_hash, full_name, role, phone, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [login, auth.hashPassword(b.password), String(b.fullName).trim(), b.role === 'admin' ? 'admin' : 'assembler', b.phone || null, U.now()]
  );
  res.json({ ok: true, id: r.insertId });
}));

router.patch('/staff/:id', auth.requireStaff, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const map = { fullName: 'full_name', phone: 'phone', role: 'role' };
  const sets = [];
  const p = [];
  for (const [key, col] of Object.entries(map)) {
    if (b[key] !== undefined) { sets.push(`${col} = ?`); p.push(b[key]); }
  }
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    sets.push('password_hash = ?');
    p.push(auth.hashPassword(b.password));
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  p.push(req.params.id);
  await db.run(`UPDATE staff SET ${sets.join(', ')} WHERE id = ?`, p);
  res.json({ ok: true });
}));

/* ============================ РЕЗЕРВНАЯ КОПИЯ БД ============================ */
/** Консистентный дамп базы (VACUUM INTO) — файл скачивается как вложение. */
router.get('/admin/backup', auth.requireStaff, asyncRoute(async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = require('path').join(require('path').dirname(cfg.db.file), 'backups');
  const file = await db.backup(require('path').join(dir, `pcbuilder-${stamp}.db`));
  res.download(file, `pcbuilder-${stamp}.db`);
}));

/* ============================ СТАТИСТИКА ============================ */
router.get('/stats', auth.requireStaff, asyncRoute(async (_req, res) => {
  const byStatus = await db.all('SELECT status, COUNT(*) AS c FROM orders GROUP BY status');
  const money = await db.get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'paid'");
  const todaySql = "SELECT COUNT(*) AS c FROM orders WHERE DATE(created_at) = DATE('now')";
  const today = await db.get(todaySql);
  const clientsCount = await db.get('SELECT COUNT(*) AS c FROM clients');
  const clientsNew = await db.get(
    "SELECT COUNT(*) AS c FROM clients WHERE DATE(created_at) >= DATE('now','-30 day')"
  );
  const inWork = await db.get(
    "SELECT COUNT(*) AS c FROM orders WHERE status IN ('paid','purchasing','assembling','testing','ready','shipped')"
  );
  const lowThreshold = Number((await settings.get('stock.lowThreshold', 3))) || 3;
  const lowStock = await db.all(
    'SELECT id, name, category, stock, reserved, min_stock FROM components WHERE stock <= ? ORDER BY stock LIMIT 10',
    [lowThreshold]
  );
  const lowStockCount = await db.get('SELECT COUNT(*) AS c FROM components WHERE stock <= ?', [lowThreshold]);
  const suppliesInTransit = await db.get("SELECT COUNT(*) AS c FROM supplies WHERE status <> 'received'");
  const unpaid = await db.get("SELECT COUNT(*) AS c FROM orders WHERE payment_status <> 'paid' AND status NOT IN ('cancelled','completed')");
  const avg = await db.get("SELECT COALESCE(AVG(total),0) AS a FROM orders WHERE status NOT IN ('cancelled')");

  // Ряд для графика: 14 последних дней — сколько заказов и сколько денег
  const seriesRows = await db.all(
    `SELECT d.day,
            (SELECT COUNT(*) FROM orders o WHERE DATE(o.created_at) = d.day) AS orders,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.status = 'paid' AND DATE(p.paid_at) = d.day) AS revenue
       FROM (SELECT DATE('now', '-' || n || ' day') AS day FROM (
              SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
              UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9
              UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 13)) d
      ORDER BY d.day`
  );

  // Загрузка по сборщикам
  const byAssembler = await db.all(
    `SELECT s.id, s.full_name,
            COUNT(o.id) AS total,
            SUM(CASE WHEN o.status IN ('paid','purchasing','assembling','testing','ready') THEN 1 ELSE 0 END) AS wip,
            SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) AS done
       FROM staff s LEFT JOIN orders o ON o.assembler_id = s.id
      GROUP BY s.id ORDER BY total DESC`
  );

  const counts = {};
  for (const s of C.ORDER_STATUSES) counts[s.id] = 0;
  for (const r of byStatus) counts[r.status] = U.num(r.c);

  res.json({
    counts,
    revenue: U.num(money?.s),
    today: U.num(today?.c),
    inWork: U.num(inWork?.c),
    clients: U.num(clientsCount?.c),
    clientsNew: U.num(clientsNew?.c),
    avgOrder: U.num(avg?.a),
    unpaid: U.num(unpaid?.c),
    suppliesInTransit: U.num(suppliesInTransit?.c),
    lowStockCount: U.num(lowStockCount?.c),
    lowStock: lowStock.map((r) => ({ ...r, stock: U.num(r.stock), reserved: U.num(r.reserved) })),
    series: seriesRows.map((r) => ({ day: r.day, orders: U.num(r.orders), revenue: U.num(r.revenue) })),
    byAssembler,
  });
}));

/* ============================ ПУБЛИЧНЫЙ ТРЕКИНГ ============================ */
/** Подтверждение получения по трек-номеру + коду из накладной (без входа в кабинет). */
router.post('/track/:number/confirm', asyncRoute(async (req, res) => {
  const ship = await db.get('SELECT * FROM shipments WHERE track_number = ?', [req.params.number]);
  if (!ship) return res.status(404).json({ error: 'Отправление не найдено' });
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код подтверждения из накладной' });
  const data = await orders.confirmReceipt(ship.order_id, code, 'client');
  res.json(orders.serialize(data));
}));

router.get('/track/:number', asyncRoute(async (req, res) => {
  const ship = await db.get('SELECT * FROM shipments WHERE track_number = ?', [req.params.number]);
  if (!ship) return res.status(404).json({ error: 'Отправление не найдено' });
  const events = await db.all('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id DESC', [ship.id]);
  const order = await db.get(
    'SELECT id, order_no, status, city, address, delivery_type, payment_status, payment_method, total FROM orders WHERE id = ?',
    [ship.order_id]
  );
  res.json({
    // Внимание: confirm_code намеренно НЕ отдаём — иначе любой сможет подтвердить получение
    shipment: {
      ...ship, cost: U.num(ship.cost), weight_kg: U.num(ship.weight_kg),
      carrier: ship.carrier, eta: ship.eta, status: ship.status,
    },
    events,
    order: order ? { ...order, total: U.num(order.total) } : null,
    canConfirm: !!(order && order.status === 'shipped'),
  });
}));

module.exports = router;
