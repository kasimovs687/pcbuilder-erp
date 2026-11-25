/**
 * Локальные секреты: стартовые логины/пароли и адрес сайта.
 *
 * Файл `secrets.local.json` лежит рядом с server.js, но НЕ попадает в репозиторий
 * (см. .gitignore). Поэтому пароли стартовых аккаунтов знает только владелец копии:
 * при первом запуске они генерируются случайно и печатаются в консоль один раз.
 *
 * Приоритет значений: переменные окружения (ADMIN_PASSWORD, …) → secrets.local.json → генерация.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'secrets.local.json');

/** Без похожих друг на друга символов: 0/O, 1/l/I — чтобы пароль можно было продиктовать. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPassword(len = 16) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function write(data) {
  fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try { fs.chmodSync(FILE, 0o600); } catch { /* Windows: права не применить — не критично */ }
}

/**
 * Читает секреты и при первом запуске создаёт файл со случайными паролями.
 * Возвращает готовый объект: логины, пароли, адрес сайта.
 */
function ensure() {
  const data = read();
  let created = false;

  const logins = { adminLogin: 'admin', assemblerLogin: 'assembler', clientPhone: '+79990000000' };
  for (const [key, value] of Object.entries(logins)) {
    if (!data[key]) { data[key] = value; created = true; }
  }

  for (const key of ['adminPassword', 'assemblerPassword', 'clientPassword']) {
    if (!data[key]) { data[key] = randomPassword(16); created = true; }
  }

  if (typeof data.publicUrl !== 'string') { data.publicUrl = ''; created = true; }

  if (created) {
    write(data);
    console.log('');
    console.log('  [секреты] создан secrets.local.json — стартовые доступы (только у вас):');
    console.log(`    админ   : ${data.adminLogin} / ${data.adminPassword}`);
    console.log(`    сборщик : ${data.assemblerLogin} / ${data.assemblerPassword}`);
    console.log(`    клиент  : ${data.clientPhone} / ${data.clientPassword}`);
    console.log('  Файл не попадает в git. Пароли можно сменить в нём или через переменные окружения.');
    console.log('');
  }

  return data;
}

module.exports = { ensure, read, write, randomPassword, FILE };
