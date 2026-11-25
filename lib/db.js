/**
 * Слой данных: встроенная SQLite (node:sqlite).
 * Единый API: all / get / run / exec / transaction / backup / check.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

let sqlite = null;

const log = (...a) => console.log('[db]', ...a);

function now() {
  // 'YYYY-MM-DD HH:MM:SS' — формат понятный SQLite
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function normParams(params) {
  return (params || []).map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    return p;
  });
}

async function init() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error(
      'Встроенная SQLite недоступна. Запускайте через: node --experimental-sqlite server.js (или start.bat)'
    );
  }
  const file = cfg.db.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new DatabaseSync(file);
  // WAL — чтобы чтение не блокировалось записью, busy_timeout — чтобы не было «database is locked»
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA synchronous = NORMAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  log('драйвер: SQLite (файл', file, ')');
  return 'sqlite';
}

function driver() {
  return 'sqlite';
}

async function all(sql, params = []) {
  const p = normParams(params);
  return sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const p = normParams(params);
  const res = sqlite.prepare(sql).run(...p);
  return { insertId: Number(res.lastInsertRowid), affectedRows: Number(res.changes) };
}

async function exec(sql) {
  sqlite.exec(sql);
}

/** Счётчик строк в таблице (для /api/health и дашборда). */
async function count(table) {
  const row = await get(`SELECT COUNT(*) AS c FROM ${table}`);
  return row ? Number(row.c) : 0;
}

async function transaction(fn) {
  sqlite.exec('BEGIN');
  try {
    const res = await fn({
      all: async (s, p = []) => sqlite.prepare(s).all(...normParams(p)).map((r) => ({ ...r })),
      get: async (s, p = []) => {
        const rows = sqlite.prepare(s).all(...normParams(p));
        return rows[0] || null;
      },
      run: async (s, p = []) => {
        const r = sqlite.prepare(s).run(...normParams(p));
        return { insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) };
      },
    });
    sqlite.exec('COMMIT');
    return res;
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Консистентная резервная копия БД целиком (VACUUM INTO работает, даже когда
 * сервер работает и в базе висят активные WAL-транзакции).
 */
async function backup(destFile) {
  const dir = path.dirname(destFile);
  fs.mkdirSync(dir, { recursive: true });
  const target = fs.existsSync(destFile) ? `${destFile}.${Date.now()}` : destFile;
  sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/** Проверка целостности БД — показывается в панели «Настройки». */
async function check() {
  const integrity = await get('PRAGMA integrity_check');
  const fk = await all('PRAGMA foreign_key_check');
  return {
    integrity: (integrity && integrity.integrity_check) || 'ok',
    foreignKeys: fk.length,
    ok: (integrity && integrity.integrity_check === 'ok') && fk.length === 0,
  };
}

function tableNames() {
  return sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name);
}

/** Аккуратное закрытие БД при остановке сервера. */
function close() {
  if (!sqlite) return;
  try { sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); sqlite.close(); } catch { /* уже закрыта */ }
  sqlite = null;
}

module.exports = { init, driver, all, get, run, exec, count, transaction, backup, check, tableNames, close, now };