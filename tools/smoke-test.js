/**
 * Сквозной сценарий проверки: клиент собирает ПК -> заказ -> оплата -> приёмка ->
 * сборка -> отправка -> подтверждение получения. Запуск: node tools/smoke-test.js
 *
 * Адрес и учётные данные берутся из окружения (BASE, ADMIN_PASSWORD, …),
 * иначе — из secrets.local.json, который создаётся при первом запуске сервера.
 */
const secrets = require('../lib/secrets').read();
const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const ADMIN = { login: process.env.ADMIN_LOGIN || secrets.adminLogin || 'admin', password: process.env.ADMIN_PASSWORD || secrets.adminPassword };
const CLIENT = { login: process.env.CLIENT_PHONE || secrets.clientPhone, password: process.env.CLIENT_PASSWORD || secrets.clientPassword };

function jar() {
  const store = {};
  return {
    async req(path, opts = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (Object.keys(store).length) {
        headers.Cookie = Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ');
      }
      const res = await fetch(BASE + path, { ...opts, headers });
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      raw.forEach((c) => {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        store[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${data?.error || ''}`);
      return data;
    },
  };
}

const log = (...a) => console.log('•', ...a);

(async () => {
  const client = jar();
  const staff = jar();

  log('вход клиентом');
  await client.req('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ login: CLIENT.login, password: CLIENT.password }),
  });

  const cats = ['CPU', 'GPU', 'Motherboard', 'RAM', 'PSU', 'Case', 'Storage', 'Cooler'];
  const items = [];
  for (const c of cats) {
    const list = await client.req(`/api/components?category=${c}`);
    if (!list.length) throw new Error('нет компонентов в категории ' + c);
    items.push({ componentId: list[0].id, qty: 1 });
  }

  log('создание заказа');
  let order = await client.req('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      items, deliveryType: 'courier', city: 'Москва', address: 'ул. Тестовая, 1',
      recipient: 'Демо Клиент', recipientPhone: '+79990000000', paymentMethod: 'card',
      comment: 'тестовый заказ',
    }),
  });
  const id = order.order.id;
  log('заказ', order.order.order_no, 'на сумму', order.order.total, '₽, статус', order.order.status);

  // --- Арифметика заказа: позиции + тарифы должны сходиться в итог ---
  const meta = await client.req('/api/meta');
  if (!order.items.length) throw new Error('в заказе нет позиций');
  const expectedParts = order.items.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
  const expectedAssembly = Number(meta.fees.assembly);
  const expectedDelivery = Number(meta.fees.delivery[order.order.delivery_type] || 0);
  const checks = [
    ['parts_total', Number(order.order.parts_total), expectedParts],
    ['assembly_fee', Number(order.order.assembly_fee), expectedAssembly],
    ['delivery_cost', Number(order.order.delivery_cost), expectedDelivery],
    ['total', Number(order.order.total), expectedParts + expectedAssembly + expectedDelivery],
  ];
  for (const [name, actual, expected] of checks) {
    if (Math.abs(actual - expected) > 0.01) throw new Error(`${name}: ожидалось ${expected}, получено ${actual}`);
  }
  if (expectedParts <= 0) throw new Error('сумма комплектующих равна нулю — цены не подставились');
  log('арифметика сходится:', checks.map((c) => `${c[0]}=${c[1]}`).join(' · '));

  log('оплата');
  order = await client.req(`/api/orders/${id}/pay`, { method: 'POST', body: JSON.stringify({ method: 'card' }) });
  log('статус оплаты:', order.order.payment_status, '| статус заказа:', order.order.status);

  log('вход сборщиком');
  await staff.req('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ login: ADMIN.login, password: ADMIN.password, role: 'staff' }),
  });
  const stats = await staff.req('/api/stats');
  log('статистика: в работе', stats.inWork, '| клиентов', stats.clients, '| оплат', stats.revenue);
  if (!Array.isArray(stats.series) || stats.series.length !== 14) {
    throw new Error('в статистике нет ряда за 14 дней');
  }
  if (!Array.isArray(stats.byAssembler)) throw new Error('в статистике нет загрузки по сборщикам');

  log('состояние системы и целостность БД');
  const health = await staff.req('/api/health');
  if (!health.ok) throw new Error('БД повреждена: ' + health.integrity);
  if (health.foreignKeyErrors > 0) throw new Error('ошибки внешних ключей: ' + health.foreignKeyErrors);
  log('БД целостна, таблиц:', health.tables.length, '| записей:', Object.values(health.counts).reduce((a, b) => a + b, 0));

  log('настройки: тарифы и реквизиты');
  const before = await staff.req('/api/settings');
  await staff.req('/api/settings', {
    method: 'PATCH', body: JSON.stringify({ 'fees.assembly': 4321, 'company.phone': '+7 (000) 123-45-67' }),
  });
  const after = await staff.req('/api/settings');
  if (Number(after.fees.assembly) !== 4321) throw new Error('тариф сборки не сохранился в БД');
  if (after.requisites.phone !== '+7 (000) 123-45-67') throw new Error('реквизиты не сохранились в БД');
  const meta2 = await staff.req('/api/meta');
  if (Number(meta2.fees.assembly) !== 4321) throw new Error('/api/meta отдаёт старый тариф');
  // возвращаем как было
  await staff.req('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ 'fees.assembly': before.fees.assembly, 'company.phone': before.requisites.phone }),
  });
  log('тарифы и реквизиты пишутся в settings и возвращаются в /api/meta');

  log('закупка -> сборка -> тесты -> готов');
  for (const st of ['purchasing', 'assembling', 'testing', 'ready']) {
    await staff.req(`/api/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: st }) });
  }

  log('SMS-уведомления по этапам заказа');
  await staff.req('/api/settings', { method: 'PATCH', body: JSON.stringify({ 'sms.enabled': true, 'sms.provider': 'log' }) });
  let smsRows = await staff.req(`/api/sms?orderId=${id}`);
  const events = new Set(smsRows.rows.map((m) => m.event));
  for (const e of ['paid', 'purchasing', 'assembling', 'ready']) {
    if (!events.has(e)) throw new Error(`нет SMS по событию ${e} (есть: ${[...events].join(', ') || 'ничего'})`);
  }
  if (smsRows.rows.some((m) => m.status !== 'sent')) throw new Error('SMS должны быть отправлены в режиме журнала');
  const dupes = smsRows.rows.filter((m) => m.event === 'assembling').length;
  if (dupes > 1) throw new Error('событие "сборка" продублировано (тестирование shouldn\'т давать второе SMS)');

  const optOut = await client.req('/api/me', { method: 'PATCH', body: JSON.stringify({ smsOptIn: false }) });
  if (Number(optOut.user.sms_opt_in) !== 0) throw new Error('клиент не может отключить уведомления');
  await client.req('/api/me', { method: 'PATCH', body: JSON.stringify({ smsOptIn: true }) });

  const shipped = await staff.req(`/api/orders/${id}/ship`, {
    method: 'POST', body: JSON.stringify({ carrier: 'СДЭК', cost: 700, weight: 12, eta: 'через 3 дня' }),
  });
  const shipSms = (await staff.req(`/api/sms?orderId=${id}`)).rows.find((m) => m.event === 'shipped');
  if (!shipSms) throw new Error('SMS об отправке не создан');
  if (!shipSms.text.includes(shipped.order.track_number)) throw new Error('в SMS об отправке нет трек-номера');

  // Клиент отписался — сообщения не отправляются; подписался — снова отправляются.
  await client.req('/api/me', { method: 'PATCH', body: JSON.stringify({ smsOptIn: false }) });
  const countBefore = (await staff.req(`/api/sms?orderId=${id}`)).stats.total;
  await staff.req('/api/sms/send', { method: 'POST', body: JSON.stringify({ orderId: id, event: 'arrived' }) });
  const countAfterOff = (await staff.req(`/api/sms?orderId=${id}`)).stats.total;
  if (countAfterOff !== countBefore) throw new Error('SMS отправлены, хотя клиент отписался');
  await client.req('/api/me', { method: 'PATCH', body: JSON.stringify({ smsOptIn: true }) });
  await staff.req('/api/sms/send', { method: 'POST', body: JSON.stringify({ orderId: id, event: 'arrived' }) });
  const arrived = (await staff.req(`/api/sms?orderId=${id}`)).rows.find((m) => m.event === 'arrived');
  if (!arrived) throw new Error('после подписки SMS снова не отправляется');

  log('этапы с SMS:', [...new Set((await staff.req(`/api/sms?orderId=${id}`)).rows.map((m) => m.event))].join(' → '));

  log('приёмка позиций на склад');
  const detail = await staff.req(`/api/orders/${id}`);
  for (const it of detail.items) {
    await staff.req(`/api/order-items/${it.id}/receive`, { method: 'POST', body: JSON.stringify({}) });
  }

  log('создание поставки и приёмка');
  const sup = await staff.req('/api/supplies', {
    method: 'POST',
    body: JSON.stringify({
      supplier: 'Тест-поставщик', invoiceNo: 'SMOKE-1', orderId: id,
      items: [{ componentId: items[0].componentId, qty: 3, purchasePrice: 10000 }],
    }),
  });
  await staff.req(`/api/supplies/${sup.id}/receive`, { method: 'POST', body: JSON.stringify({}) });

  log('оформление отправки');
  const track = shipped.order.track_number;
  log('трек-номер', track, '| код получения', shipped.order.confirm_code);
  await staff.req(`/api/orders/${id}/tracking`, {
    method: 'POST', body: JSON.stringify({ status: 'in_transit', location: 'Москва', note: 'в пути' }),
  });

  log('публичное отслеживание (без входа в систему)');
  const anon = jar();
  const pub = await anon.req('/api/track/' + track);
  log('трек', pub.shipment.track_number, '· заказ', pub.order.order_no, '· canConfirm', pub.canConfirm);
  if (pub.shipment.confirm_code) throw new Error('confirm_code не должен отдаваться публично');
  if (!pub.events.length) throw new Error('нет событий трекинга');

  const page = await fetch(BASE + '/track');
  if (!page.ok) throw new Error('страница /track недоступна: ' + page.status);
  log('страница /track отдаётся без авторизации:', page.status);

  // deep-link из SMS: /track/<номер> должен открывать страницу трекинга
  const deep = await fetch(BASE + '/track/' + encodeURIComponent(track));
  if (!deep.ok) throw new Error('deep-link /track/<трек> недоступен: ' + deep.status);
  const deepHtml = await deep.text();
  if (!/Отслеживание заказа|track-input/.test(deepHtml)) {
    throw new Error('deep-link /track/<трек> отдал не страницу трекинга');
  }
  log('deep-link /track/<трек> работает:', deep.status);

  // ассеты страницы трекинга должны отдаваться как css/js, а не как html
  for (const asset of ['/style.css', '/common.js', '/track.js']) {
    const r = await fetch(BASE + asset);
    const type = r.headers.get('content-type') || '';
    if (!r.ok || type.includes('text/html')) throw new Error(`ассет ${asset} отдаётся некорректно (${type})`);
  }
  // то же для конфигуратора
  for (const asset of ['/builder/styles.css', '/builder/app.js', '/builder/data.js']) {
    const r = await fetch(BASE + asset);
    const type = r.headers.get('content-type') || '';
    if (!r.ok || type.includes('text/html')) throw new Error(`ассет ${asset} отдаётся некорректно (${type})`);
  }
  log('ассеты интерфейсов отдаются с правильным MIME-типом');

  log('неверный код получения должен отклоняться');
  const badCode = shipped.order.confirm_code === '0000' ? '1111' : '0000';
  let rejected = false;
  try {
    await anon.req(`/api/track/${track}/confirm`, { method: 'POST', body: JSON.stringify({ code: badCode }) });
  } catch { rejected = true; }
  if (!rejected) throw new Error('неверный код подтверждения был принят');
  log('неверный код отклонён');

  log('подтверждение получения по треку + коду (как на странице /track)');
  const done = await anon.req(`/api/track/${track}/confirm`, {
    method: 'POST', body: JSON.stringify({ code: shipped.order.confirm_code }),
  });
  log('итоговый статус:', done.order.status, '| оплата:', done.order.payment_status);

  log('закрытие заказа сборщиком: delivered -> completed');
  const closed = await staff.req(`/api/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
  log('статус после закрытия:', closed.order.status);
  if (closed.order.status !== 'completed') throw new Error('заказ не перешёл в completed');

  const my = await client.req('/api/orders/my');
  log('заказов у клиента:', my.length);
  console.log('\n✅ Сквозной сценарий пройден без ошибок');
})().catch((e) => {
  console.error('\n❌ Ошибка сценария:', e.message);
  process.exit(1);
});
