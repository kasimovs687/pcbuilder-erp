/**
 * Настройки компании и тарифов — в таблице `settings` (ключ → значение).
 *
 * Зачем: реквизиты для печатных документов и тарифы сборки/доставки меняются
 * из интерфейса, без правки кода. Значения по умолчанию берутся из config.js
 * и засеиваются один раз (ensureDefaults).
 */
const db = require('./db');
const cfg = require('../config');
const C = require('./constants');

/** Плоские ключи «секция.поле» + их значения по умолчанию. */
function defaults() {
  // Шаблоны SMS лежат в lib/sms.js, а тот использует настройки — берём лениво,
  // чтобы не было циклической загрузки модулей на старте.
  const smsTemplates = require('./sms').DEFAULT_TEMPLATES;
  const d = {};
  for (const [k, v] of Object.entries(cfg.company)) d[`company.${k}`] = v;
  d['fees.assembly'] = cfg.fees.assembly;
  for (const type of Object.keys(C.DELIVERY_TYPES)) {
    d[`fees.delivery.${type}`] = cfg.fees.delivery[type] ?? 0;
  }
  d['stock.lowThreshold'] = cfg.lowStockThreshold;

  // SMS-уведомления клиенту
  d['sms.enabled'] = cfg.sms.enabled;
  d['sms.provider'] = cfg.sms.provider;
  d['sms.login'] = cfg.sms.login;
  d['sms.password'] = cfg.sms.password;
  d['sms.sender'] = cfg.sms.sender;
  d['sms.webhookUrl'] = cfg.sms.webhookUrl;
  d['sms.linkBase'] = cfg.sms.linkBase;
  for (const [k, v] of Object.entries(smsTemplates)) d[`sms.tpl.${k}`] = v;
  return d;
}

/** Приводим строку из БД к типу значения по умолчанию. */
function coerce(defaultValue, raw) {
  if (typeof defaultValue === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  }
  if (typeof defaultValue === 'boolean') {
    // Приходит и из БД строка ('1'/'true'/'0'), и из интерфейса — настоящий boolean.
    if (typeof raw === 'boolean') return raw;
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'да';
  }
  return raw == null ? '' : String(raw);
}

let cache = null;

async function load(force = false) {
  if (cache && !force) return cache;
  const map = defaults();
  const rows = await db.all('SELECT key, value FROM settings');
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(map, r.key)) map[r.key] = coerce(map[r.key], r.value);
  }
  cache = map;
  return map;
}

async function all(force = false) {
  return load(force);
}

async function get(key, fallback = '') {
  const map = await load();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

/** Upsert настроек. Принимаются только известные ключи. Возвращает изменённые. */
async function set(patch) {
  const map = await load();
  const known = new Set(Object.keys(map));
  const changed = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!known.has(key)) continue;
    const value = coerce(map[key], raw);
    if (String(map[key]) === String(value)) continue;
    changed[key] = value;
    await db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, String(value), db.now()]
    );
  }
  if (Object.keys(changed).length) cache = null;
  await load(true);
  return changed;
}

/** Засев значений по умолчанию при первом запуске (и для новых ключей после обновления). */
async function ensureDefaults() {
  const map = defaults();
  const rows = await db.all('SELECT key FROM settings');
  const have = new Set(rows.map((r) => r.key));
  const missing = Object.entries(map).filter(([k]) => !have.has(k));
  for (const [k, v] of missing) {
    await db.run('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [k, String(v), db.now()]);
  }
  cache = null;
  await load(true);
  return missing.length;
}

/** Тарифы в том же виде, что раньше жёстко в config.fees: { assembly, delivery: {...} }. */
async function fees() {
  const map = await load();
  const delivery = {};
  for (const type of Object.keys(C.DELIVERY_TYPES)) {
    delivery[type] = Number(map[`fees.delivery.${type}`]) || 0;
  }
  return { assembly: Number(map['fees.assembly']) || 0, delivery };
}

/** Реквизиты компании одним объектом. */
async function company() {
  const map = await load();
  const out = {};
  for (const k of Object.keys(cfg.company)) out[k] = map[`company.${k}`];
  return out;
}

/** Настройки SMS для панели: пароль отдаём замаскированным. */
const SECRET_KEYS = new Set(['sms.password']);
async function masked() {
  const map = await load();
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = SECRET_KEYS.has(k) && v ? '••••••' : v;
  return out;
}

/** Публичная часть (видна всем, в том числе конфигуратору и странице трекинга). */
async function publicMeta() {
  const c = await company();
  return {
    brand: c.brand,
    company: c.name,
    tagline: c.tagline,
    phone: c.phone,
    email: c.email,
    address: c.address,
    workHours: c.workHours,
  };
}

module.exports = { load, all, get, set, ensureDefaults, fees, company, publicMeta, defaults, masked };