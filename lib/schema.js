/**
 * Схема базы данных SQLite + миграции.
 *
 * SCHEMA применяется на каждом запуске (все CREATE IF NOT EXISTS),
 * поэтому файл data/pcbuilder.db можно просто обновлять новой версией.
 * Новые колонки в уже существующие таблицы добавляет migrate().
 */
const db = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  city          TEXT,
  address       TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'assembler',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_type  TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS components (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         INTEGER UNIQUE,
  category          TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  image             TEXT,
  price             REAL NOT NULL DEFAULT 0,
  socket            TEXT,
  ram_type          TEXT,
  tdp               INTEGER,
  wattage           INTEGER,
  performance_index INTEGER,
  stock             INTEGER NOT NULL DEFAULT 0,
  reserved          INTEGER NOT NULL DEFAULT 0,
  brand             TEXT,
  cores             INTEGER,
  threads           INTEGER,
  memory_gb         INTEGER,
  capacity_gb       INTEGER,
  form_factor       TEXT,
  interface         TEXT,
  efficiency        TEXT,
  cooler_type       TEXT,
  max_memory_gb     INTEGER,
  length            INTEGER,
  modules           INTEGER,
  speed             INTEGER,
  tags              TEXT,
  specs             TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  min_stock         INTEGER NOT NULL DEFAULT 3,
  updated_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT NOT NULL UNIQUE,
  client_id       INTEGER NOT NULL,
  assembler_id    INTEGER,
  status          TEXT NOT NULL DEFAULT 'new',
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  payment_method  TEXT,
  delivery_type   TEXT NOT NULL DEFAULT 'courier',
  city            TEXT,
  address         TEXT,
  recipient       TEXT,
  recipient_phone TEXT,
  parts_total     REAL NOT NULL DEFAULT 0,
  assembly_fee    REAL NOT NULL DEFAULT 0,
  delivery_cost   REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  track_number    TEXT,
  confirm_code    TEXT,
  comment         TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         TEXT,
  assembled_at    TEXT,
  shipped_at      TEXT,
  delivered_at    TEXT,
  confirmed_at    TEXT,
  updated_at      TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL,
  component_id INTEGER,
  category     TEXT NOT NULL,
  name         TEXT NOT NULL,
  price        REAL NOT NULL DEFAULT 0,
  qty          INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'ordered',
  supply_id    INTEGER,
  received_at  TEXT,
  serial       TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL,
  amount         REAL NOT NULL DEFAULT 0,
  method         TEXT NOT NULL DEFAULT 'card',
  status         TEXT NOT NULL DEFAULT 'pending',
  transaction_id TEXT,
  comment        TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at        TEXT
);
CREATE TABLE IF NOT EXISTS shipments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL,
  carrier      TEXT NOT NULL DEFAULT 'Курьерская служба',
  track_number TEXT NOT NULL,
  address      TEXT,
  city         TEXT,
  cost         REAL NOT NULL DEFAULT 0,
  weight_kg    REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'created',
  eta          TEXT,
  comment      TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  shipped_at   TEXT,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS shipment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  status      TEXT NOT NULL,
  location    TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS supplies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier    TEXT NOT NULL DEFAULT 'Поставщик',
  invoice_no  TEXT,
  order_id    INTEGER,
  status      TEXT NOT NULL DEFAULT 'in_transit',
  total       REAL NOT NULL DEFAULT 0,
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_at TEXT
);
CREATE TABLE IF NOT EXISTS supply_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_id      INTEGER NOT NULL,
  component_id   INTEGER,
  name           TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  purchase_price REAL NOT NULL DEFAULT 0,
  order_item_id  INTEGER
);
CREATE TABLE IF NOT EXISTS order_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'client',
  author_name TEXT,
  message     TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'system',
  kind       TEXT NOT NULL DEFAULT 'info',
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* SMS-уведомления клиенту: журнал всех попыток отправки */
CREATE TABLE IF NOT EXISTS sms_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER,
  client_id   INTEGER,
  phone       TEXT,
  event       TEXT NOT NULL DEFAULT 'custom',
  text        TEXT,
  status      TEXT NOT NULL DEFAULT 'sent',
  provider    TEXT,
  provider_id TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_order ON order_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_track ON shipments(track_number);
CREATE INDEX IF NOT EXISTS idx_events_shipment ON shipment_events(shipment_id);
CREATE INDEX IF NOT EXISTS idx_order_events ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_created ON order_events(created_at);
CREATE INDEX IF NOT EXISTS idx_supply_items ON supply_items(supply_id);
CREATE INDEX IF NOT EXISTS idx_supplies_status ON supplies(status);
CREATE INDEX IF NOT EXISTS idx_components_category ON components(category);
CREATE INDEX IF NOT EXISTS idx_sms_order ON sms_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_sms_created ON sms_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_status ON sms_messages(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_type, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

/**
 * Лёгкие миграции: ALTER TABLE ADD COLUMN для баз, созданных прошлыми версиями.
 * Идемпотентны — можно звать при каждом старте.
 */
const ADDED_COLUMNS = [
  // порог «заканчивается» для склада
  ['components', 'min_stock', 'min_stock INTEGER NOT NULL DEFAULT 3'],
  // телефон сборщика — для связи с клиентом по заказу
  ['staff', 'phone', 'phone TEXT'],
  // каталог 2026: полные характеристики для подбора сборок
  ['components', 'brand', 'brand TEXT'],
  ['components', 'cores', 'cores INTEGER'],
  ['components', 'threads', 'threads INTEGER'],
  ['components', 'memory_gb', 'memory_gb INTEGER'],
  ['components', 'capacity_gb', 'capacity_gb INTEGER'],
  ['components', 'form_factor', 'form_factor TEXT'],
  ['components', 'interface', 'interface TEXT'],
  ['components', 'efficiency', 'efficiency TEXT'],
  ['components', 'cooler_type', 'cooler_type TEXT'],
  ['components', 'max_memory_gb', 'max_memory_gb INTEGER'],
  ['components', 'length', 'length INTEGER'],
  ['components', 'modules', 'modules INTEGER'],
  ['components', 'speed', 'speed INTEGER'],
  ['components', 'tags', 'tags TEXT'],
  ['components', 'specs', 'specs TEXT'],
  ['components', 'archived', 'archived INTEGER NOT NULL DEFAULT 0'],
  ['components', 'updated_at', 'updated_at TEXT'],
  // SMS-уведомления: клиент может отписаться от них
  ['clients', 'sms_opt_in', 'sms_opt_in INTEGER NOT NULL DEFAULT 1'],
];

async function columnsOf(table) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

async function migrate() {
  const applied = [];
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = await columnsOf(table);
    if (!cols.includes(column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      applied.push(`${table}.${column}`);
    }
  }
  return applied;
}

async function apply() {
  await db.exec(SCHEMA);
  return migrate();
}

async function reset() {
  const tables = [
    'order_events', 'order_messages', 'supply_items', 'supplies', 'shipment_events', 'shipments',
    'payments', 'order_items', 'orders', 'components', 'sessions', 'staff', 'clients', 'settings',
    'sms_messages',
  ];
  for (const t of tables) await db.exec(`DROP TABLE IF EXISTS ${t}`);
  await apply();
}

module.exports = { apply, reset, migrate, SCHEMA };