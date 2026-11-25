/** Статусы, справочники и правила переходов - общее для сервера и клиента. */

const ORDER_STATUSES = [
  { id: 'new',        label: 'Оформлен',              color: '#64748B', hint: 'Заказ создан клиентом, ожидает оплаты' },
  { id: 'paid',       label: 'Оплачен',               color: '#0EA5E9', hint: 'Оплата подтверждена, можно запускать в работу' },
  { id: 'purchasing', label: 'Закупка комплектующих', color: '#8B5CF6', hint: 'Комплектующие заказаны у поставщиков' },
  { id: 'assembling', label: 'Сборка',                color: '#6C2BD9', hint: 'Сборщик собирает системный блок' },
  { id: 'testing',    label: 'Тестирование',          color: '#F59E0B', hint: 'Стресс-тесты, проверка температур' },
  { id: 'ready',      label: 'Готов к отправке',      color: '#14B8A6', hint: 'Собран, упакован, ждёт курьера' },
  { id: 'shipped',    label: 'Отправлен',             color: '#3B82F6', hint: 'Передан в службу доставки' },
  { id: 'delivered',  label: 'Доставлен',             color: '#22C55E', hint: 'Клиент получил заказ' },
  { id: 'completed',  label: 'Завершён',              color: '#16A34A', hint: 'Заказ закрыт' },
  { id: 'cancelled',  label: 'Отменён',               color: '#EF4444', hint: 'Отменён' },
];

// Колонки канбана в панели сборщика (завершённые тоже видны — чтобы заказ не «исчезал»)
const KANBAN = ['new', 'paid', 'purchasing', 'assembling', 'testing', 'ready', 'shipped', 'delivered', 'completed'];

const STATUS_FLOW = {
  new:        ['paid', 'cancelled'],
  paid:       ['purchasing', 'cancelled'],
  purchasing: ['assembling', 'cancelled'],
  assembling: ['testing', 'cancelled'],
  testing:    ['ready', 'assembling', 'cancelled'],
  ready:      ['shipped', 'cancelled'],
  shipped:    ['delivered', 'cancelled'],
  delivered:  ['completed'],
  completed:  [],
  cancelled:  ['new'],
};

const PAYMENT_STATUSES = {
  unpaid: 'Не оплачен',
  pending: 'Ожидает подтверждения',
  paid: 'Оплачен',
  on_delivery: 'Оплата при получении',
  refunded: 'Возврат',
};

const PAYMENT_METHODS = {
  card: 'Банковская карта онлайн',
  sbp: 'СБП / перевод по номеру',
  invoice: 'Счёт для юрлица',
  cash: 'Наличными при получении',
};

const DELIVERY_TYPES = {
  pickup: 'Самовывоз из мастерской',
  courier: 'Курьер до двери',
  cdek: 'СДЭК до пункта выдачи',
  post: 'Почта России',
};

const SHIPMENT_STATUSES = {
  created: 'Отправление создано',
  packing: 'Упаковка',
  in_transit: 'В пути',
  sorting: 'В сортировочном центре',
  out_for_delivery: 'Курьер везёт заказ',
  arrived: 'Прибыл в пункт выдачи',
  delivered: 'Вручено клиенту',
  returned: 'Возврат',
};

/** Порядок статусов отправления — для «ступенек» на странице трекинга. */
const SHIPMENT_FLOW = [
  'created', 'packing', 'in_transit', 'sorting', 'out_for_delivery', 'arrived', 'delivered',
];

/**
 * Крупные этапы заказа для клиента: 9 статусов канбана свёрнуты в 7 понятных шагов.
 * Клиенту не нужно знать про «закупку комплектующих» и «тестирование» по отдельности.
 */
const ORDER_STAGES = [
  { id: 'new', label: 'Оформлен', statuses: ['new'] },
  { id: 'paid', label: 'Оплачен', statuses: ['paid'] },
  { id: 'procure', label: 'Закупка', statuses: ['purchasing'] },
  { id: 'build', label: 'Сборка', statuses: ['assembling', 'testing'] },
  { id: 'ready', label: 'Готов', statuses: ['ready'] },
  { id: 'shipped', label: 'Доставка', statuses: ['shipped'] },
  { id: 'done', label: 'Получен', statuses: ['delivered', 'completed'] },
];

const ITEM_STATUS = {
  ordered: 'Заказан у поставщика',
  reserved: 'Зарезервирован на складе',
  received: 'Получен на склад',
};

const CARRIERS = ['Курьерская служба PCBuild', 'СДЭК', 'Boxberry', 'DPD', 'Почта России', 'Самовывоз'];

module.exports = {
  ORDER_STATUSES, KANBAN, STATUS_FLOW, PAYMENT_STATUSES, PAYMENT_METHODS,
  DELIVERY_TYPES, SHIPMENT_STATUSES, SHIPMENT_FLOW, ORDER_STAGES, ITEM_STATUS, CARRIERS,
};
