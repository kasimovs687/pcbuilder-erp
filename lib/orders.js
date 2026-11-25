/** Бизнес-логика заказов: создание, оплата, статусы, склад, логистика, приёмка. */
const db = require('./db');
const settings = require('./settings');
const U = require('./util');
const C = require('./constants');
const sms = require('./sms');

/** Полная стоимость заказа: комплектующие + сборка + доставка по тарифу из настроек.
 *  items: [{ price, qty }] */
async function calcTotals(items, deliveryType) {
  const partsTotal = items.reduce((s, i) => s + U.num(i.price) * U.num(i.qty), 0);
  const fees = await settings.fees();
  const assemblyFee = U.num(fees.assembly);
  const deliveryCost = U.num(fees.delivery[deliveryType] ?? 0);
  return { partsTotal, assemblyFee, deliveryCost, total: partsTotal + assemblyFee + deliveryCost };
}

/** Создание заказа из конфигурации клиента. */
async function createOrder({
  clientId,
  items = [],
  deliveryType = 'courier',
  city = '',
  address = '',
  recipient = '',
  recipientPhone = '',
  paymentMethod = 'card',
  comment = '',
}) {
  if (!clientId) throw new Error('Не указан клиент');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Сборка пуста - добавьте компоненты');

  const clean = [];
  for (const raw of items) {
    const qty = Math.max(1, U.num(raw.qty) || 1);
    let comp = null;
    if (raw.componentId) comp = await db.get('SELECT * FROM components WHERE id = ?', [raw.componentId]);
    if (!comp && raw.sourceId) comp = await db.get('SELECT * FROM components WHERE source_id = ?', [raw.sourceId]);
    if (!comp && raw.name) comp = await db.get('SELECT * FROM components WHERE name = ? LIMIT 1', [raw.name]);
    if (!comp) throw new Error(`Компонент не найден: ${raw.name || raw.componentId}`);
    clean.push({ comp, qty });
  }

  const { partsTotal, assemblyFee, deliveryCost, total } = await calcTotals(
    clean.map((i) => ({ price: i.comp.price, qty: i.qty })),
    deliveryType
  );

  const res = await db.run(
    `INSERT INTO orders (order_no, client_id, status, payment_status, payment_method, delivery_type,
      city, address, recipient, recipient_phone, parts_total, assembly_fee, delivery_cost, total,
      comment, created_at, updated_at)
     VALUES (?, ?, 'new', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      U.genOrderNo(), clientId, paymentMethod, deliveryType, city, address, recipient,
      recipientPhone, U.money(partsTotal), U.money(assemblyFee), U.money(deliveryCost),
      U.money(total), comment, U.now(), U.now(),
    ]
  );
  const orderId = res.insertId;
  await db.run('UPDATE orders SET order_no = ? WHERE id = ?', [U.genOrderNo(orderId), orderId]);

  for (const { comp, qty } of clean) {
    const available = U.num(comp.stock) - U.num(comp.reserved);
    const status = available >= qty ? 'reserved' : 'ordered';
    await db.run(
      `INSERT INTO order_items (order_id, component_id, category, name, price, qty, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, comp.id, comp.category, comp.name, U.money(comp.price), qty, status]
    );
    if (status === 'reserved') {
      await db.run('UPDATE components SET reserved = reserved + ? WHERE id = ?', [qty, comp.id]);
    }
  }

  await U.addEvent(orderId, 'client', 'created', `Заказ создан. Позиций: ${clean.length}. Сумма: ${U.money(total)} ₽`);
  return fetchOrder(orderId);
}

async function fetchOrder(orderId) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
  const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', [orderId]);
  const shipment = await db.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  let events = null;
  if (shipment) {
    events = await db.all(
      'SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id DESC',
      [shipment.id]
    );
  }
  const history = await db.all(
    'SELECT * FROM order_events WHERE order_id = ? ORDER BY id DESC',
    [orderId]
  );
  const client = await db.get(
    'SELECT id, full_name, phone, email, city, address, sms_opt_in FROM clients WHERE id = ?',
    [order.client_id]
  );
  const assembler = order.assembler_id
    ? await db.get('SELECT id, full_name, role FROM staff WHERE id = ?', [order.assembler_id])
    : null;
  const messages = await db.all(
    'SELECT id, event, text, status, created_at, sent_at FROM sms_messages WHERE order_id = ? ORDER BY id DESC LIMIT 20',
    [orderId]
  );
  return { order, items, payments, shipment, tracking: events, history, client, assembler, messages };
}

function serialize(raw) {
  if (!raw) return null;
  const o = raw.order || raw;
  const order = {
    ...o,
    parts_total: U.num(o.parts_total),
    assembly_fee: U.num(o.assembly_fee),
    delivery_cost: U.num(o.delivery_cost),
    total: U.num(o.total),
  };
  const items = (raw.items || []).map((i) => ({ ...i, price: U.num(i.price), qty: U.num(i.qty) }));
  const payments = (raw.payments || []).map((p) => ({ ...p, amount: U.num(p.amount) }));
  const shipment = raw.shipment ? { ...raw.shipment, cost: U.num(raw.shipment.cost), weight_kg: U.num(raw.shipment.weight_kg) } : null;
  return { ...raw, order, items, payments, shipment };
}

/** Смена статуса заказа сборщиком. */
async function setStatus(orderId, status, actor = 'staff', note = '', force = false) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Заказ не найден');
  if (!C.ORDER_STATUSES.some((s) => s.id === status)) throw new Error('Неизвестный статус');
  const changed = order.status !== status;
  if (!force && changed) {
    const allowed = C.STATUS_FLOW[order.status] || [];
    if (!allowed.includes(status)) {
      throw new Error(`Нельзя перевести заказ из «${order.status}» в «${status}»`);
    }
  }
  const fields = { status, updated_at: U.now() };
  if (status === 'paid') fields.paid_at = U.now();
  if (status === 'shipped') fields.shipped_at = U.now();
  if (status === 'delivered') fields.delivered_at = U.now();

  const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  await db.run(`UPDATE orders SET ${setSql} WHERE id = ?`, [...Object.values(fields), orderId]);
  await U.addEvent(
    orderId,
    actor,
    'status',
    `Статус изменён: «${C.ORDER_STATUSES.find((s) => s.id === order.status)?.label}» → «${
      C.ORDER_STATUSES.find((s) => s.id === status)?.label
    }»${note ? '. ' + note : ''}`
  );

  // Клиенту уходит SMS только при реальной смене этапа — и никогда не ломает заказ.
  if (changed) {
    const event = sms.ORDER_EVENT[status];
    if (event) await sms.notifyOrder(orderId, event);
  }
  return fetchOrder(orderId);
}

/** Регистрация оплаты. method: card | sbp | invoice | cash */
async function payOrder(orderId, method, actor = 'client', amount = null) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Заказ не найден');
  const sum = amount != null ? U.money(amount) : U.num(order.total);

  await db.run(
    `INSERT INTO payments (order_id, amount, method, status, transaction_id, comment, created_at, paid_at)
     VALUES (?, ?, ?, 'paid', ?, ?, ?, ?)`,
    [orderId, sum, method, 'TX' + Date.now(), `Оплата: ${C.PAYMENT_METHODS[method] || method}`, U.now(), U.now()]
  );

  const paymentStatus = method === 'cash' ? 'on_delivery' : 'paid';
  await db.run(
    `UPDATE orders SET payment_status = ?, payment_method = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
    [paymentStatus, method, method === 'cash' ? null : U.now(), U.now(), orderId]
  );
  await U.addEvent(orderId, actor, 'payment', `Оплата ${sum} ₽ (${C.PAYMENT_METHODS[method] || method})`);

  // После оплаты заказ автоматически уходит в работу
  if (order.status === 'new') {
    await setStatus(orderId, 'paid', actor, 'Оплата подтверждена', true);
  }
  return fetchOrder(orderId);
}

/** Подтверждение оплаты сборщиком (для безнала/счёта). */
async function confirmPayment(orderId, actor = 'staff', ok = true) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Заказ не найден');
  if (!ok) {
    await db.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', ['unpaid', U.now(), orderId]);
    await U.addEvent(orderId, actor, 'payment', 'Оплата отклонена, ожидаем поступления');
    return fetchOrder(orderId);
  }
  await db.run(
    'UPDATE orders SET payment_status = ?, paid_at = ?, updated_at = ? WHERE id = ?',
    ['paid', U.now(), U.now(), orderId]
  );
  await db.run(
    "UPDATE payments SET status = 'paid', paid_at = ? WHERE order_id = ? AND status <> 'paid'",
    [U.now(), orderId]
  );
  await U.addEvent(orderId, actor, 'payment', 'Оплата подтверждена сборщиком');
  if (order.status === 'new') await setStatus(orderId, 'paid', actor, 'Оплата подтверждена', true);
  return fetchOrder(orderId);
}

/** Оформление отправки (логистика). */
async function shipOrder(orderId, opts = {}, actor = 'staff') {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Заказ не найден');
  const track = opts.trackNumber || U.genTrack();
  const code = U.genConfirmCode();
  const cost = opts.cost != null ? U.money(opts.cost) : U.num(order.delivery_cost);
  const eta = opts.eta || `${new Date(Date.now() + 3 * 86400000).toLocaleDateString('ru-RU')}`;

  await db.run(
    `INSERT INTO shipments (order_id, carrier, track_number, address, city, cost, weight_kg, status, eta, comment, created_at, shipped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
    [
      orderId, opts.carrier || 'Курьерская служба PCBuild', track,
      opts.address || order.address, opts.city || order.city, cost,
      U.num(opts.weight || 12), eta, opts.comment || '', U.now(), U.now(),
    ]
  );
  const shipment = await db.get('SELECT * FROM shipments WHERE track_number = ?', [track]);
  await db.run(
    'INSERT INTO shipment_events (shipment_id, status, location, note, created_at) VALUES (?, ?, ?, ?, ?)',
    [shipment.id, 'created', opts.city || order.city || 'Склад PCBuild', `Отправление создано. Перевозчик: ${opts.carrier || 'Курьерская служба PCBuild'}`, U.now()]
  );
  await db.run('UPDATE orders SET track_number = ?, confirm_code = ?, shipped_at = ?, updated_at = ? WHERE id = ?',
    [track, code, U.now(), U.now(), orderId]);
  await setStatus(orderId, 'shipped', actor, `Отправление ${track}`, true);
  return fetchOrder(orderId);
}

async function addShipmentEvent(orderId, status, location, note, actor = 'staff') {
  const shipment = await db.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  if (!shipment) throw new Error('Отправление не найдено');
  const prev = shipment.status;
  await db.run(
    'INSERT INTO shipment_events (shipment_id, status, location, note, created_at) VALUES (?, ?, ?, ?, ?)',
    [shipment.id, status, location || '', note || '', U.now()]
  );
  await db.run('UPDATE shipments SET status = ? WHERE id = ?', [status, shipment.id]);
  if (status === 'delivered') {
    await db.run('UPDATE shipments SET delivered_at = ? WHERE id = ?', [U.now(), shipment.id]);
  }
  await U.addEvent(orderId, actor, 'logistics', `${C.SHIPMENT_STATUSES[status] || status}${location ? ' · ' + location : ''}`);

  // В пути / курьер / пункт выдачи / вручено — у клиента появляется SMS.
  // Повтор того же статуса уведомление не дублирует.
  if (prev !== status) {
    const event = sms.SHIPMENT_EVENT[status];
    if (event) {
      const current = await db.get('SELECT status, track_number FROM orders WHERE id = ?', [orderId]);
      // Сообщение с трек-номером уже ушло при оформлении отправки — не повторяем.
      const alreadyInformed = event === 'shipped' && current && current.status === 'shipped' && current.track_number;
      if (!alreadyInformed) {
        await sms.notifyOrder(orderId, event, { vars: { location: location || '' } });
      }
    }
  }
  return fetchOrder(orderId);
}

/** Клиент подтверждает получение товара по коду. */
async function confirmReceipt(orderId, code, actor = 'client') {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Заказ не найден');
  if (order.status !== 'shipped') throw new Error('Заказ ещё не в доставке');
  if (String(code).trim() !== String(order.confirm_code)) throw new Error('Неверный код подтверждения');
  await db.run('UPDATE orders SET delivered_at = ?, confirmed_at = ?, updated_at = ? WHERE id = ?',
    [U.now(), U.now(), U.now(), orderId]);
  const shipment = await db.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  if (shipment) {
    await db.run('UPDATE shipments SET status = ?, delivered_at = ? WHERE id = ?', ['delivered', U.now(), shipment.id]);
    await db.run(
      'INSERT INTO shipment_events (shipment_id, status, location, note, created_at) VALUES (?, ?, ?, ?, ?)',
      [shipment.id, 'delivered', shipment.city || '', 'Клиент подтвердил получение', U.now()]
    );
  }
  await U.addEvent(orderId, actor, 'receipt', 'Клиент подтвердил получение заказа');
  if (order.payment_status === 'on_delivery') {
    await db.run(
      `INSERT INTO payments (order_id, amount, method, status, transaction_id, comment, created_at, paid_at)
       VALUES (?, ?, 'cash', 'paid', ?, ?, ?, ?)`,
      [orderId, U.num(order.total), 'CASH' + Date.now(), 'Оплата наложенным платежом при получении', U.now(), U.now()]
    );
    await db.run("UPDATE orders SET payment_status = 'paid', paid_at = ? WHERE id = ?", [U.now(), orderId]);
    await U.addEvent(orderId, actor, 'payment', 'Оплата при получении подтверждена');
  }
  await setStatus(orderId, 'delivered', actor, 'Получено клиентом', true);
  return fetchOrder(orderId);
}

/** Приёмка поставки комплектующих на склад. */
async function receiveSupply(supplyId, actor = 'staff') {
  const supply = await db.get('SELECT * FROM supplies WHERE id = ?', [supplyId]);
  if (!supply) throw new Error('Поставка не найдена');
  if (supply.status === 'received') throw new Error('Поставка уже принята');

  await db.run('UPDATE supplies SET status = ?, received_at = ? WHERE id = ?', ['received', U.now(), supplyId]);
  const rows = await db.all('SELECT * FROM supply_items WHERE supply_id = ?', [supplyId]);
  const touchedOrders = new Set();

  for (const item of rows) {
    if (item.component_id) {
      await db.run('UPDATE components SET stock = stock + ?, reserved = reserved + 0 WHERE id = ?',
        [U.num(item.qty), item.component_id]);
    }
    if (item.order_item_id) {
      const oi = await db.get('SELECT * FROM order_items WHERE id = ?', [item.order_item_id]);
      if (oi) {
        await db.run(
          "UPDATE order_items SET status = 'received', supply_id = ?, received_at = ? WHERE id = ?",
          [supplyId, U.now(), item.order_item_id]
        );
        touchedOrders.add(oi.order_id);
      }
    }
  }

  for (const orderId of touchedOrders) {
    const pending = await db.all(
      "SELECT id FROM order_items WHERE order_id = ? AND status <> 'received'",
      [orderId]
    );
    await U.addEvent(orderId, actor, 'stock', `Принята поставка №${supplyId} (${rows.length} поз.)`);
    if (pending.length === 0) {
      const o = await db.get('SELECT status FROM orders WHERE id = ?', [orderId]);
      await U.addEvent(orderId, 'system', 'stock', 'Все комплектующие получены - можно приступать к сборке');
      if (o && o.status === 'purchasing') {
        await setStatus(orderId, 'assembling', 'system', 'Комплект укомплектован', true);
      }
    }
  }
  return true;
}

module.exports = {
  createOrder, fetchOrder, serialize, setStatus, payOrder, confirmPayment,
  shipOrder, addShipmentEvent, confirmReceipt, receiveSupply, calcTotals,
};
