/**
 * Каталог комплектующих: синхронизация data.js → таблица `components` и чтение обратно.
 *
 * Раньше каталог только засеивался один раз, и со временем в нём копились дубли
 * и записи с пустыми характеристиками. Теперь data.js — единственный источник правды,
 * а syncCatalog() приводит таблицу в порядок при каждом запуске:
 *   • новые позиции добавляются, существующие обновляются (цены/характеристики/названия),
 *   • позиции, которых больше нет в каталоге, архивируются (если на них ссылаются заказы)
 *     или удаляются, если они нигде не используются.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const U = require('./util');

/** Дополнительные поля каталога → колонки таблицы components. */
const SPEC_COLUMNS = [
  ['brand', 'str'],
  ['cores', 'num'],
  ['threads', 'num'],
  ['memory_gb', 'num'],
  ['capacity_gb', 'num'],
  ['form_factor', 'str'],
  ['interface', 'str'],
  ['efficiency', 'str'],
  ['cooler_type', 'str'],
  ['max_memory_gb', 'num'],
  ['length', 'num'],
  ['modules', 'num'],
  ['speed', 'num'],
  ['tags', 'json'],
];

/** Поля, которые остаются в JSON-колонке specs (списки и параметры корпуса/охлаждения). */
const KEEP_IN_SPECS = [
  'clock', 'modules', 'sockets', 'radiator', 'height', 'supported',
  'max_gpu_length', 'max_cooler_height', 'read_speed', 'drive_type', 'modular', 'igpu',
];

/** Ключ в specs → точное имя поля в data.js. */
const SPEC_SOURCE = {
  clock: 'Clock', modules: 'Modules', sockets: 'Sockets', radiator: 'Radiator',
  height: 'Height', supported: 'Supported', max_gpu_length: 'MaxGpuLength',
  max_cooler_height: 'MaxCoolerHeight', read_speed: 'ReadSpeed',
  drive_type: 'DriveType', modular: 'Modular', igpu: 'IGPU',
};

const rowToComponent = (r) => {
  let specs = {};
  try { specs = JSON.parse(r.specs || '{}'); } catch { specs = {}; }
  let tags = [];
  try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
  return {
    Id: r.source_id,
    ComponentId: r.id,
    Category: r.category,
    Name: r.name,
    Image: r.image || '',
    Price: U.num(r.price),
    Description: r.description || '',
    Brand: r.brand || '',
    Socket: r.socket || '',
    RamType: r.ram_type || '',
    TDP: r.tdp == null ? 0 : U.num(r.tdp),
    Wattage: r.wattage == null ? 0 : U.num(r.wattage),
    PerformanceIndex: r.performance_index == null ? 0 : U.num(r.performance_index),
    Cores: r.cores == null ? 0 : U.num(r.cores),
    Threads: r.threads == null ? 0 : U.num(r.threads),
    MemoryGB: r.memory_gb == null ? 0 : U.num(r.memory_gb),
    CapacityGB: r.capacity_gb == null ? 0 : U.num(r.capacity_gb),
    FormFactor: r.form_factor || '',
    Interface: r.interface || '',
    Efficiency: r.efficiency || '',
    CoolerType: r.cooler_type || '',
    MaxMemoryGB: r.max_memory_gb == null ? 0 : U.num(r.max_memory_gb),
    Length: r.length == null ? 0 : U.num(r.length),
    Modules: r.modules == null ? 0 : U.num(r.modules),
    Speed: r.speed == null ? 0 : U.num(r.speed),
    Tags: tags,
    Specs: specs,
    // Удобные «хвосты» характеристик — чтобы алгоритм подбора и интерфейс
    // не ковырялись в JSON вручную.
    Sockets: specs.sockets || [],
    Supported: specs.supported || [],
    IGPU: specs.igpu === true,
    Height: U.num(specs.height),
    Radiator: U.num(specs.radiator),
    MaxGpuLength: U.num(specs.max_gpu_length),
    MaxCoolerHeight: U.num(specs.max_cooler_height),
    Modular: specs.modular === true,
    DriveType: specs.drive_type || '',
    ReadSpeed: U.num(specs.read_speed),
    Stock: U.num(r.stock),
    Reserved: U.num(r.reserved),
  };
};

function loadSource() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
  const fn = new Function(`${raw}\nreturn { COMPONENTS, CATEGORY_LIST };`);
  return fn();
}

function toSpecs(c) {
  const out = {};
  for (const key of KEEP_IN_SPECS) {
    const src = SPEC_SOURCE[key];
    if (c[src] !== undefined && c[src] !== null && c[src] !== '') out[key] = c[src];
  }
  return out;
}

/**
 * Приводит таблицу components в соответствие с data.js.
 * Возвращает статистику: { added, updated, archived, removed }.
 */
async function syncCatalog() {
  const { COMPONENTS } = loadSource();
  const stats = { added: 0, updated: 0, archived: 0, removed: 0, total: COMPONENTS.length };

  for (const c of COMPONENTS) {
    const row = await db.get(
      `SELECT id, name, price, socket, ram_type, tdp, wattage, performance_index, specs, tags, archived
         FROM components WHERE source_id = ?`,
      [c.Id]
    );
    const specs = JSON.stringify(toSpecs(c));
    const tags = JSON.stringify(c.Tags || []);
    const fields = [
      c.Category,
      c.Name,
      c.Description || '',
      c.Image || '',
      U.money(c.Price || 0),
      c.Socket && c.Socket !== '-' ? c.Socket : null,
      c.RamType && c.RamType !== '-' ? c.RamType : null,
      c.TDP ?? 0,
      c.Wattage ?? 0,
      c.PerformanceIndex ?? 0,
      c.Brand || null,
      c.Cores ?? null,
      c.Threads ?? null,
      c.MemoryGB ?? null,
      c.CapacityGB ?? null,
      c.FormFactor || null,
      c.Interface || null,
      c.Efficiency || null,
      c.CoolerType || null,
      c.MaxMemoryGB ?? null,
      c.Length ?? null,
      c.Modules ?? null,
      c.Speed ?? null,
      tags,
      specs,
    ];

    if (!row) {
      await db.run(
        `INSERT INTO components
          (source_id, category, name, description, image, price, socket, ram_type, tdp, wattage,
           performance_index, brand, cores, threads, memory_gb, capacity_gb, form_factor, interface,
           efficiency, cooler_type, max_memory_gb, length, modules, speed, tags, specs, stock, min_stock, archived, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        [c.Id, ...fields, 3 + (c.Id % 9), 3, U.now()]
      );
      stats.added += 1;
      continue;
    }

    // Обновляем, только если что-то реально поменялось — меньше лишних записей в WAL.
    const changed =
      row.name !== c.Name ||
      U.num(row.price) !== U.money(c.Price || 0) ||
      (row.socket || null) !== (c.Socket || null) ||
      (row.ram_type || null) !== (c.RamType || null) ||
      U.num(row.tdp) !== U.num(c.TDP ?? 0) ||
      U.num(row.wattage) !== U.num(c.Wattage ?? 0) ||
      U.num(row.performance_index) !== U.num(c.PerformanceIndex ?? 0) ||
      (row.specs || '{}') !== specs ||
      (row.tags || '[]') !== tags;

    if (changed) {
      await db.run(
        `UPDATE components SET
           category = ?, name = ?, description = ?, image = ?, price = ?, socket = ?, ram_type = ?,
           tdp = ?, wattage = ?, performance_index = ?, brand = ?, cores = ?, threads = ?, memory_gb = ?,
           capacity_gb = ?, form_factor = ?, interface = ?, efficiency = ?, cooler_type = ?,
           max_memory_gb = ?, length = ?, modules = ?, speed = ?, tags = ?, specs = ?, updated_at = ?
         WHERE id = ?`,
        [...fields, U.now(), row.id]
      );
      stats.updated += 1;
    }
    if (U.num(row.archived)) {
      await db.run('UPDATE components SET archived = 0 WHERE id = ?', [row.id]);
      stats.archived += 1;
    }
  }

  // Позиции, которых больше нет в каталоге.
  const known = new Set(COMPONENTS.map((c) => c.Id));
  const extras = await db.all('SELECT id, source_id FROM components WHERE archived = 0');
  for (const row of extras) {
    if (row.source_id != null && known.has(row.source_id)) continue;
    const used = await db.get(
      'SELECT (SELECT COUNT(*) FROM order_items WHERE component_id = ?) + (SELECT COUNT(*) FROM supply_items WHERE component_id = ?) AS c',
      [row.id, row.id]
    );
    if (used && U.num(used.c) > 0) {
      await db.run('UPDATE components SET archived = 1 WHERE id = ?', [row.id]);
      stats.archived += 1;
    } else {
      await db.run('DELETE FROM components WHERE id = ?', [row.id]);
      stats.removed += 1;
    }
  }

  return stats;
}

/** Все комплектующие каталога (без архивных) в формате конфигуратора. */
async function all() {
  const rows = await db.all(
    `SELECT * FROM components WHERE archived = 0 ORDER BY category, price`
  );
  return rows.map(rowToComponent);
}

async function byCategory(category) {
  const rows = await db.all(
    'SELECT * FROM components WHERE archived = 0 AND category = ? ORDER BY price',
    [category]
  );
  return rows.map(rowToComponent);
}

/** Компактная сводка для шапки витрины. */
async function summary() {
  const rows = await db.all(
    `SELECT category, COUNT(*) AS c, MIN(price) AS min_price, MAX(price) AS max_price
       FROM components WHERE archived = 0 GROUP BY category`
  );
  return rows;
}

module.exports = { syncCatalog, all, byCategory, summary, loadSource, rowToComponent, SPEC_COLUMNS };