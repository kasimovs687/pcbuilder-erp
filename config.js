/**
 * PCBuilder ERP — конфигурация (значения по умолчанию).
 *
 * Всё, что можно менять из интерфейса (реквизиты компании, тарифы сборки и доставки),
 * хранится в таблице `settings` — см. lib/settings.js. Здесь только стартовые значения,
 * которые засеиваются в БД при первом запуске.
 *
 * База данных: встроенная SQLite (файл data/pcbuilder.db).
 *
 * Секреты (пароли стартовых аккаунтов, адрес сайта) — в secrets.local.json,
 * который не попадает в репозиторий: см. lib/secrets.js.
 */
const path = require('path');
const secrets = require('./lib/secrets').ensure();

/** Адрес сайта для ссылок в письмах/SMS: PUBLIC_URL → secrets.local.json → пусто (относительные ссылки). */
const publicUrl = (process.env.PUBLIC_URL || secrets.publicUrl || '').replace(/\/+$/, '');

module.exports = {
  port: Number(process.env.PORT) || 3000,

  /** Публичный адрес сайта. Пустая строка — ссылки строятся относительными. */
  publicUrl,

  db: {
    // На хостинге путь к БД задаётся переменной окружения DB_FILE
    // (например, на постоянном диске: /var/data/pcbuilder.db).
    file: process.env.DB_FILE || path.join(__dirname, 'data', 'pcbuilder.db'),
  },

  sessionDays: Number(process.env.SESSION_DAYS) || 30,

  /** Реквизиты для печатных документов и подвалов интерфейсов. */
  company: {
    name: 'ООО «PCBuilder»',
    brand: 'PCBuilder',
    tagline: 'Мастерская по сборке ПК',
    inn: '7700000000',
    kpp: '770101001',
    account: '40702810100000000000',
    bank: 'ПАО «БАНК»',
    bic: '044525000',
    corr: '30101810000000000000',
    phone: '+7 (999) 000-00-00',
    email: 'info@pcbuild.ru',
    address: 'г. Москва, ул. Тверская, 7',
    workHours: 'Пн–Сб, 10:00–20:00',
  },

  /** Тарифы: сборка — фиксированно, доставка — по способу получения. */
  fees: {
    assembly: 3000,
    delivery: {
      pickup: 0,
      courier: 800,
      cdek: 500,
      post: 350,
    },
  },

  /** Порог, ниже которого комплектующий попадает в «Заканчивается». */
  lowStockThreshold: 3,

  /**
   * SMS-уведомления клиенту.
   * provider:
   *   'log'     — писать в data/sms.log и в панель (работает без внешних сервисов, по умолчанию)
   *   'smsc'    — SMSC.ru (api_id из личного кабинета)
   *   'webhook' — свой шлюз: POST { phone, text, orderNo } на sms.webhookUrl
   * Логин/пароль и тексты меняются в панели сборщика: Настройки → SMS.
   */
  sms: {
    enabled: false,
    provider: 'log',
    login: '',
    password: '',
    sender: 'PCBuild',
    webhookUrl: '',
    // Базовый адрес для ссылок в SMS: PUBLIC_URL → secrets.local.json → относительные ссылки.
    linkBase: publicUrl,
  },

  /**
   * Стартовые аккаунты. Паролей здесь нет намеренно: они берутся из secrets.local.json
   * (генерируются случайно при первом запуске) или из переменных окружения.
   * Подробнее — lib/secrets.js.
   */
  seed: {
    adminLogin: process.env.ADMIN_LOGIN || secrets.adminLogin,
    adminPassword: process.env.ADMIN_PASSWORD || secrets.adminPassword,

    assemblerLogin: process.env.ASSEMBLER_LOGIN || secrets.assemblerLogin,
    assemblerPassword: process.env.ASSEMBLER_PASSWORD || secrets.assemblerPassword,

    demoClientPhone: process.env.CLIENT_PHONE || secrets.clientPhone,
    demoClientPassword: process.env.CLIENT_PASSWORD || secrets.clientPassword,
  },
};