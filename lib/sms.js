/**
 * SMS-уведомления клиенту: «оплатили → собираем → отправили → прибыло → забрали».
 *
 * Система работает локально и без внешних зависимостей, поэтому отправка
 * вынесена в провайдеры:
 *   log     — режим по умолчанию: текст пишется в data/sms.log и в журнал БД.
 *             Ничего не отправляется наружу, но весь сценарий виден и тестируется.
 *   smsc    — SMSC.ru (https://smsc.ru), api_id + логин + пароль из личного кабинета.
 *   webhook — свой шлюз: POST { phone, text, orderNo, event } на произвольный URL.
 *
 * К каждому событию привязан шаблон в настройках; текст собирается подстановками
 * ({order}, {track}, {link}, {eta}, {total}, …). Если провайдер не настроен или
 * отправка не удалась — заказ не падает: ошибка пишется в журнал и статус сообщения.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const U = require('./util');

/** События, на которые система пишет клиенту. */
const EVENTS = [
  { id: 'paid',            title: 'Оплата получена',      when: 'заказ оплачен и ушёл в работу' },
  { id: 'purchasing',      title: 'Закупка комплектующих', when: 'сборщик заказал детали у поставщиков' },
  { id: 'assembling',      title: 'Сборка началась',      when: 'мастер приступил к сборке' },
  { id: 'ready',           title: 'Сборка готова',        when: 'система собрана и протестирована' },
  { id: 'shipped',         title: 'Отправлено',           when: 'передали перевозчику, есть трек-номер' },
  { id: 'out_for_delivery', title: 'Курьер везёт заказ',  when: 'посылка выехала к клиенту' },
  { id: 'arrived',         title: 'Прибыло в пункт выдачи', when: 'ждём в пункте выдачи' },
  { id: 'delivered',       title: 'Заказ получен',        when: 'клиент подтвердил получение' },
  { id: 'cancelled',       title: 'Заказ отменён',        when: 'заказ отменён' },
];

/** Шаблоны по умолчанию. {company} — название мастерской, {link} — ссылка на трекинг. */
const DEFAULT_TEMPLATES = {
  paid: '{company}: оплата по заказу {order} получена, сумма {total} ₽. Запускаем сборку.',
  purchasing: '{company}: по заказу {order} закупаем комплектующие. Следующее сообщение — когда начнём сборку.',
  assembling: '{company}: начали сборку заказа {order}. Сборка и тесты — в комплекте.',
  ready: '{company}: заказ {order} собран и готов. Готовим к отправке, трек-номер придёт следующим SMS.',
  shipped: '{company}: заказ {order} отправлен! Трек-номер {track}. Статус: {link}',
  out_for_delivery: '{company}: курьер везёт заказ {order} по адресу {address}. Ожидайте сегодня.',
  arrived: '{company}: заказ {order} прибыл в пункт выдачи {city} — заберите до {eta}. Код получения: {code}.',
  delivered: '{company}: заказ {order} получен. Спасибо, {name}! Если что-то не так — напишите нам.',
  cancelled: '{company}: заказ {order} отменён. Вопросы? {companyPhone}',
  custom: '{text}',
};

/** Статус заказа → событие SMS. */
const ORDER_EVENT = {
  paid: 'paid',
  purchasing: 'purchasing',
  assembling: 'assembling',
  testing: 'assembling',
  ready: 'ready',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/** Статус отправления → событие SMS. */
const SHIPMENT_EVENT = {
  in_transit: 'shipped',
  sorting: 'shipped',
  out_for_delivery: 'out_for_delivery',
  arrived: 'arrived',
  delivered: 'delivered',
};

/* ------------------------------ провайдеры ------------------------------ */

/** Режим без внешних сервисов: пишем в файл и консоль. */
async function sendLog(phone, text) {
  const file = path.join(__dirname, '..', 'data', 'sms.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `[${U.now()}] -> ${phone}: ${text}\n`, 'utf8');
  console.log(`[sms] ${phone}: ${text}`);
  return { ok: true, id: `log-${Date.now()}` };
}

/** SMSC.ru — GET с JSON-ответом, код 0 означает «принято». */
async function sendSmsc(cfg, phone, text) {
  if (!cfg.login || !cfg.password) throw new Error('Не задан логин или пароль SMSC');
  const url = new URL('https://smsc.ru/api/http/sms/send');
  url.searchParams.set('api_id', cfg.login);
  url.searchParams.set('login', cfg.login);
  url.searchParams.set('password', cfg.password);
  url.searchParams.set('to', phone);
  url.searchParams.set('text', text);
  if (cfg.sender) url.searchParams.set('sender', cfg.sender);
  url.searchParams.set('json', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`SMSC: HTTP ${res.status}`);
    const code = Array.isArray(data) ? data[0].id : data && data.id;
    if (Number(code) !== 0) {
      const err = Array.isArray(data) ? data[0] : data;
      throw new Error(`SMSC: ${err.error || `код ${code}`}`);
    }
    return { ok: true, id: String(code) };
  } finally {
    clearTimeout(timer);
  }
}

/** Свой шлюз: POST JSON. Ответ 2xx — считаем успешным. */
async function sendWebhook(cfg, phone, text, meta) {
  if (!cfg.webhookUrl) throw new Error('Не задан адрес шлюза (webhook)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, text, ...meta }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Шлюз ответил HTTP ${res.status}`);
    return { ok: true, id: `hook-${Date.now()}` };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ помощники ------------------------------ */

/** Нормализуем телефон в +7XXXXXXXXXX — операторы не любят разные форматы. */
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits[0] === '8') digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits.length === 11 ? `+${digits}` : `+${digits}`;
}

const rub = (v) => U.num(v).toLocaleString('ru-RU');

/** Подстановки в шаблон. */
function render(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : m));
}

async function config() {
  const map = await settings.load();
  return {
    enabled: map['sms.enabled'] === true || map['sms.enabled'] === 'true',
    provider: map['sms.provider'] || 'log',
    login: map['sms.login'] || '',
    password: map['sms.password'] || '',
    sender: map['sms.sender'] || '',
    webhookUrl: map['sms.webhookUrl'] || '',
    linkBase: map['sms.linkBase'] || '',
    templates: Object.fromEntries(
      Object.keys(DEFAULT_TEMPLATES).map((k) => [k, map[`sms.tpl.${k}`] || DEFAULT_TEMPLATES[k]])
    ),
  };
}

/** Что можно подставить в шаблон — для подсказки в интерфейсе. */
const PLACEHOLDERS = [
  '{order}', '{company}', '{companyPhone}', '{name}', '{total}', '{track}',
  '{link}', '{eta}', '{city}', '{address}', '{code}', '{carrier}', '{items}', '{text}',
];

/**
 * Отправка одного сообщения клиенту.
 * Всегда пишет строку в журнал sms_messages — успех, ошибка или пропуск.
 */
async function send({ orderId, clientId, phone, event = 'custom', text, vars = {} }) {
  const cfg = await config();
  const to = normalizePhone(phone);
  const body = text || render(cfg.templates[event] || cfg.templates.custom, vars);
  const row = {
    orderId: orderId || null,
    clientId: clientId || null,
    phone: to,
    event,
    text: body,
    status: 'sent',
    provider: cfg.provider,
    providerId: null,
    error: null,
  };

  const log = async (patch) => {
    await db.run(
      `INSERT INTO sms_messages (order_id, client_id, phone, event, text, status, provider, provider_id, error, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.orderId, row.clientId, row.phone, row.event, row.text, patch.status || row.status,
        row.provider, patch.providerId || null, patch.error || null, U.now(),
        patch.status === 'sent' ? U.now() : null,
      ]
    );
  };

  if (!to) {
    row.status = 'failed';
    row.error = 'не указан телефон';
    await log({ status: 'failed', error: row.error });
    return { ok: false, error: row.error };
  }
  if (!cfg.enabled) {
    row.status = 'skipped';
    row.error = 'уведомления выключены в настройках';
    await log({ status: 'skipped', error: row.error });
    return { ok: false, skipped: true, error: row.error };
  }

  try {
    let res;
    if (cfg.provider === 'smsc') res = await sendSmsc(cfg, to, body);
    else if (cfg.provider === 'webhook') res = await sendWebhook(cfg, to, body, { event, orderId: orderId || null });
    else res = await sendLog(to, body);
    row.status = 'sent';
    row.providerId = res.id;
    await log({ status: 'sent', providerId: res.id });
    return { ok: true, id: res.id };
  } catch (e) {
    row.status = 'failed';
    row.error = String(e.message || e);
    await log({ status: 'failed', error: row.error });
    console.warn('[sms] не отправлено:', to, row.error);
    return { ok: false, error: row.error };
  }
}

/** Собирает значения для шаблона по заказу. */
async function varsForOrder(orderId) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const client = await db.get('SELECT full_name, phone, sms_opt_in FROM clients WHERE id = ?', [order.client_id]);
  const company = await settings.company();
  const shipment = await db.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  const items = await db.all('SELECT category, name, qty FROM order_items WHERE order_id = ?', [orderId]);
  const cfg = await config();
  const firstName = String(client?.full_name || '').split(' ')[0] || 'клиент';
  const track = order.track_number || (shipment && shipment.track_number) || '';

  return {
    order: order,
    client,
    company,
    shipment,
    vars: {
      order: order.order_no,
      company: company.brand || company.name,
      companyPhone: company.phone,
      name: firstName,
      total: rub(order.total),
      track: track || '—',
      link: track ? `${String(cfg.linkBase || '').replace(/\/$/, '')}/track/${track}` : '—',
      eta: (shipment && shipment.eta) || 'сегодня',
      city: order.city || (shipment && shipment.city) || '—',
      address: [order.city, order.address].filter(Boolean).join(', ') || '—',
      code: order.confirm_code || '—',
      carrier: (shipment && shipment.carrier) || 'курьерская служба',
      location: '',
      items: items.map((i) => `${i.name} × ${i.qty}`).join(', '),
    },
  };
}

/**
 * Уведомление по событию заказа. Молча выходит, если клиент отписался
 * или у него нет телефона — заказ от этого никогда не ломается.
 * Повтор того же события подряд не дублируется: например, «Сборка» и «Тестирование»
 * дают одно сообщение, а не два.
 */
async function notifyOrder(orderId, event, extra = {}) {
  try {
    const data = await varsForOrder(orderId);
    if (!data) return { ok: false, error: 'заказ не найден' };
    if (data.client && data.client.sms_opt_in === 0) return { ok: false, skipped: true, error: 'клиент отключил уведомления' };
    if (!extra.text) {
      const last = await db.get('SELECT event FROM sms_messages WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
      if (last && last.event === event) return { ok: false, skipped: true, error: 'такое уведомление уже отправлено' };
    }
    return await send({
      orderId,
      clientId: data.order.client_id,
      phone: data.client?.phone || data.order.recipient_phone,
      event,
      text: extra.text,
      vars: { ...data.vars, ...extra.vars },
    });
  } catch (e) {
    console.warn('[sms] notifyOrder:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Журнал сообщений (для панели сборщика). */
async function history({ limit = 100, status = '', orderId = null } = {}) {
  const p = [];
  let sql = 'SELECT s.*, o.order_no FROM sms_messages s LEFT JOIN orders o ON o.id = s.order_id WHERE 1=1';
  if (status) { sql += ' AND s.status = ?'; p.push(status); }
  if (orderId) { sql += ' AND s.order_id = ?'; p.push(orderId); }
  sql += ' ORDER BY s.id DESC LIMIT ?';
  p.push(Math.min(Number(limit) || 100, 500));
  return db.all(sql, p);
}

async function stats() {
  const row = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM sms_messages`
  );
  const cfg = await config();
  const since = U.now().slice(0, 10);
  const today = await db.get('SELECT COUNT(*) AS c FROM sms_messages WHERE created_at LIKE ?', [`${since}%`]);
  return {
    total: U.num(row.total), sent: U.num(row.sent), failed: U.num(row.failed),
    skipped: U.num(row.skipped), today: U.num(today.c),
    enabled: cfg.enabled, provider: cfg.provider, templates: cfg.templates,
  };
}

/** Тестовое сообщение — из настроек, чтобы проверить канал перед боевым запуском. */
async function test(phone) {
  const cfg = await config();
  return send({
    phone,
    event: 'custom',
    text: `${cfg.templates.custom.replace('{text}', '')}Тестовое SMS от PCBuilder. Если вы его видите — канал настроен верно.`.trim(),
  });
}

module.exports = {
  EVENTS, DEFAULT_TEMPLATES, ORDER_EVENT, SHIPMENT_EVENT, PLACEHOLDERS,
  send, notifyOrder, history, stats, test, config, normalizePhone,
};