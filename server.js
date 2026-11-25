/**
 * PCBuilder ERP - сервер.
 *   Главная (выбор роли): http://localhost:PORT/
 *   Кабинет клиента:      http://localhost:PORT/client
 *   Панель сборщика:      http://localhost:PORT/assembler
 *   Конфигуратор ПК:      http://localhost:PORT/builder
 *   Отслеживание:         http://localhost:PORT/track/<трек-номер>
 */
const path = require('path');
const fs = require('fs');
const httpLayer = require('./lib/http');

const cfg = require('./config');
const db = require('./lib/db');
const schema = require('./lib/schema');
const seed = require('./lib/seed');
const auth = require('./lib/auth');
const routes = require('./lib/routes');
const orders = require('./lib/orders');
const settings = require('./lib/settings');
const C = require('./lib/constants');
const U = require('./lib/util');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const BUILDER_FILES = new Set(['index.html', 'app.js', 'data.js', 'styles.css']);

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rub = (v) => U.num(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/** Печатные формы: заказ-наряд, счёт, акт приёма-передачи. Реквизиты — из настроек БД. */
function printHtml(data, doc, company) {
  const o = data.order;
  const items = data.items || [];
  const titles = {
    waybill: 'ЗАКАЗ-НАРЯД / ТОВАРНАЯ НАКЛАДНАЯ',
    invoice: 'СЧЁТ НА ОПЛАТУ',
    act: 'АКТ ПРИЁМА-ПЕРЕДАЧИ КОМПЬЮТЕРА',
  };
  const title = titles[doc] || titles.waybill;
  const status = C.ORDER_STATUSES.find((s) => s.id === o.status) || { label: o.status };

  const rows = items.map((i, n) => `
    <tr>
      <td class="c">${n + 1}</td>
      <td>${esc(i.category)} — ${esc(i.name)}</td>
      <td class="c">${U.num(i.qty)}</td>
      <td class="r">${rub(i.price)}</td>
      <td class="r">${rub(U.num(i.price) * U.num(i.qty))}</td>
    </tr>`).join('');

  const payRows = (data.payments || []).map((p) => `
    <tr><td>${esc(String(p.created_at).slice(0, 16))}</td>
      <td>${esc(C.PAYMENT_METHODS[p.method] || p.method)}</td>
      <td class="r">${rub(p.amount)}</td>
      <td>${esc(C.PAYMENT_STATUSES[p.status] || p.status)}</td></tr>`).join('');

  const actBlock = doc === 'act' ? `
    <div class="block">
      <h3>Подтверждение получения</h3>
      <p>Код подтверждения получения: <b class="code">${esc(o.confirm_code || '—')}</b></p>
      <p class="small">Комплектация проверена, внешний вид и работоспособность системы проверены,
      претензий по комплектации и внешнему виду нет.</p>
      <div class="signs">
        <div><div class="line"></div><div class="small">Сдал: ${esc(company.name)}</div></div>
        <div><div class="line"></div><div class="small">Принял: ${esc(o.recipient || (o.client && o.client.full_name) || '')}</div></div>
      </div>
      <div class="small" style="margin-top:10px">Дата получения: «___» ________ 20___ г. &nbsp;&nbsp; Подпись: ______________</div>
    </div>` : '';

  const invoiceBlock = doc === 'invoice' ? `
    <div class="block">
      <h3>Реквизиты для оплаты</h3>
      <p class="small">Получатель: ${esc(company.name)}<br>ИНН / КПП: ${esc(company.inn)} / ${esc(company.kpp)}<br>
      Р/с: ${esc(company.account)} в ${esc(company.bank)}<br>БИК: ${esc(company.bic)} &nbsp; К/с: ${esc(company.corr)}</p>
      <p class="small">Назначение платежа: оплата по заказу ${esc(o.order_no)}</p>
      <table class="t"><thead><tr><th>Дата</th><th>Способ оплаты</th><th class="r">Сумма</th><th>Статус</th></tr></thead>
      <tbody>${payRows || '<tr><td colspan="4">Платежей пока нет</td></tr>'}</tbody></table>
    </div>` : '';

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<title>${title} ${esc(o.order_no)}</title>
<style>
  body{font:13px/1.5 "Segoe UI",Arial,sans-serif;color:#111;margin:0;padding:28px;background:#fff}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:12px}
  h1{font-size:17px;margin:0 0 6px;letter-spacing:.04em}
  h3{font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em}
  .small{font-size:11.5px;color:#555}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  .t th,.t td{border:1px solid #bbb;padding:6px 8px}
  .t th{background:#f2f2f2;font-size:11.5px;text-transform:uppercase}
  .c{text-align:center}.r{text-align:right}
  .totals{width:45%;margin-left:auto;margin-top:10px}
  .totals td{padding:3px 8px}
  .block{border:1px solid #bbb;padding:12px;margin-top:14px}
  .code{font-size:18px;letter-spacing:.18em;background:#f3f0ff;padding:2px 10px;border-radius:6px}
  .signs{display:flex;gap:40px;margin-top:26px}
  .signs>div{flex:1}
  .line{border-bottom:1px solid #111;height:26px}
  .noprint{margin:0 0 14px;display:flex;gap:8px}
  @media print{ .noprint{display:none} body{padding:0} }
</style></head><body>
<div class="noprint">
  <button onclick="window.print()" style="padding:8px 14px;border-radius:8px;border:1px solid #111;background:#6C2BD9;color:#fff;font-weight:600;cursor:pointer">Печать / PDF</button>
  <button onclick="window.close()" style="padding:8px 14px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer">Закрыть</button>
</div>
<div class="head">
  <div>
    <h1>${title}</h1>
    <div>№ ${esc(o.order_no)} от ${esc(String(o.created_at).slice(0, 10))}</div>
    <div class="small">Статус заказа: <b>${esc(status.label)}</b></div>
  </div>
  <div style="text-align:right">
    <b>${esc(company.name)}</b>
    <div class="small">${esc(company.tagline)}<br>тел. ${esc(company.phone)}<br>${esc(company.email)}</div>
  </div>
</div>

<div class="block">
  <h3>Клиент и доставка</h3>
  <table>
    <tr><td style="width:150px">Клиент</td><td><b>${esc((o.client && o.client.full_name) || '')}</b></td></tr>
    <tr><td>Телефон</td><td>${esc((o.client && o.client.phone) || o.recipient_phone || '')}</td></tr>
    <tr><td>Получатель</td><td>${esc(o.recipient || '')} ${esc(o.recipient_phone || '')}</td></tr>
    <tr><td>Способ получения</td><td>${esc(C.DELIVERY_TYPES[o.delivery_type] || o.delivery_type)}</td></tr>
    <tr><td>Адрес</td><td>${esc(o.city || '')} ${esc(o.address || '')}</td></tr>
    ${o.track_number ? `<tr><td>Трек-номер</td><td><b>${esc(o.track_number)}</b>${o.confirm_code ? ' · код получения: <b>' + esc(o.confirm_code) + '</b>' : ''}</td></tr>` : ''}
    ${o.comment ? `<tr><td>Пожелания</td><td>${esc(o.comment)}</td></tr>` : ''}
  </table>
</div>

<div class="block">
  <h3>Состав сборки</h3>
  <table class="t">
    <thead><tr><th style="width:34px">№</th><th>Компонент</th><th style="width:60px">Кол-во</th><th class="r" style="width:110px">Цена</th><th class="r" style="width:110px">Сумма</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td>Комплектующие</td><td class="r">${rub(o.parts_total)}</td></tr>
    <tr><td>Сборка и тестирование</td><td class="r">${rub(o.assembly_fee)}</td></tr>
    <tr><td>Доставка</td><td class="r">${rub(o.delivery_cost)}</td></tr>
    <tr><td><b>Итого, ₽</b></td><td class="r"><b>${rub(o.total)}</b></td></tr>
  </table>
</div>

${invoiceBlock}${actBlock}

<div class="small" style="margin-top:18px">
  Документ сформирован автоматически ${esc(U.now())} · ${esc(company.brand)} ERP
</div>
</body></html>`;
}

async function main() {
  await db.init();
  const added = await schema.apply();
  if (added.length) console.log('[db] миграции применены:', added.join(', '));
  await settings.ensureDefaults();
  const catalogStats = await seed.seedAll();
  if (catalogStats && (catalogStats.added || catalogStats.updated || catalogStats.archived || catalogStats.removed)) {
    console.log(`[каталог] позиций в data.js: ${catalogStats.total} · добавлено: ${catalogStats.added}, ` +
      `обновлено: ${catalogStats.updated}, в архиве: ${catalogStats.archived}, удалено: ${catalogStats.removed}`);
  }

  const company = await settings.company();

  const app = httpLayer.createApp();
  app.use(httpLayer.jsonBody());
  app.use(auth.attachUser);

  // --- Интерфейсы: роль-выбор, кабинет клиента, панель сборщика ---
  app.use('/', httpLayer.serveStatic(PUBLIC));
  app.get('/client', (_req, res) => res.sendFile(path.join(PUBLIC, 'client.html')));
  app.get('/assembler', (_req, res) => res.sendFile(path.join(PUBLIC, 'assembler.html')));

  // --- Публичное отслеживание: /track и deep-link /track/<трек-номер> (ссылка из SMS) ---
  // Точка в колонке не считается трек-номером: иначе страница перехватывала бы /track/style.css
  app.get(['/track', '/track/'], (_req, res) => res.sendFile(path.join(PUBLIC, 'track.html')));
  app.get('/track/:number', (req, res, next) => {
    if (String(req.params.number).includes('.')) return next();
    res.sendFile(path.join(PUBLIC, 'track.html'));
  });

  // --- Конфигуратор ПК (файлы лежат в корне проекта: index.html, app.js, data.js, styles.css, images/) ---
  const builderStatic = httpLayer.serveStatic(ROOT, { index: false });
  app.use('/builder', (req, res, next) => {
    const name = path.basename(req.path);
    const isAsset = BUILDER_FILES.has(name) || req.path.startsWith('/builder/images/');
    if (!isAsset) return next();
    // serveStatic ждёт путь относительно каталога — убираем префикс /builder
    const saved = req.path;
    req.path = req.path.slice('/builder'.length) || '/';
    builderStatic(req, res, (err) => { req.path = saved; next(err); });
  });
  app.get(['/builder', '/builder/'], (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

  // --- API ---
  app.use('/api', routes);

  // --- Состояние системы (мониторинг, «Панель сборщика → Настройки») ---
  app.get('/health', async (_req, res) => {
    const ok = await db.check();
    res.json({ ok: ok.ok, driver: db.driver(), uptimeSec: Math.round(process.uptime()), db: cfg.db.file });
  });

  // --- Печатные документы по заказу: накладная, счёт, акт приёма-передачи ---
  app.get('/print/:id', async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).send('Войдите в систему, чтобы открыть документ');
      const data = await orders.fetchOrder(req.params.id);
      if (!data) return res.status(404).send('Заказ не найден');
      const isOwner = req.user.type === 'client' && data.order.client_id === req.user.id;
      if (!isOwner && req.user.type !== 'staff') return res.status(403).send('Нет доступа к заказу');
      res.send(printHtml(data, req.query.doc || 'waybill', await settings.company()));
    } catch (e) { next(e); }
  });

  const errorHandler = (err, req, res, _next) => {
    console.error('[error]', req.method, req.path, '—', err.message);
    const status = err.status || 500;
    if (String(req.headers.accept || '').includes('application/json') || req.path.startsWith('/api')) {
      return res.status(status).json({ error: err.message || 'Ошибка запроса' });
    }
    res.status(status).send(httpLayer.notFoundPage(req.path));
  };

  const startPort = cfg.port;
  let port = startPort;
  let server = null;
  for (let i = 0; i < 12; i++) {
    try {
      server = httpLayer.createServer(app, { errorHandler });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve());
      });
      break;
    } catch (e) {
      server = null;
      if (e.code === 'EADDRINUSE') { port += 1; continue; }
      throw e;
    }
  }

  // Публичный адрес (PUBLIC_URL) — для ссылок в SMS и печатных формах;
  // локальный нужен только чтобы открыть сайт на этой машине.
  const url = cfg.publicUrl || `http://localhost:${port}`;
  console.log('');
  console.log('  PCBuilder ERP запущен');
  console.log('  -------------------------------------------------------');
  console.log(`  Главная (выбор роли)   : ${url}/`);
  console.log(`  Кабинет клиента        : ${url}/client`);
  console.log(`  Панель сборщика        : ${url}/assembler`);
  console.log(`  Конфигуратор ПК        : ${url}/builder`);
  console.log(`  Отслеживание доставки  : ${url}/track`);
  console.log(`  Состояние системы      : ${url}/api/health`);
  console.log(`  База данных            : SQLite (${cfg.db.file})`);
  console.log('  -------------------------------------------------------');
  console.log(`  Вход сборщика : ${cfg.seed.adminLogin} (пароль — secrets.local.json)`);
  console.log(`  Вход клиента  : ${cfg.seed.demoClientPhone} (пароль — secrets.local.json)`);
  console.log('');
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'port.txt'), String(port));

  // Корректное завершение: закрываем сервер и базу
  const shutdown = (signal) => {
    console.log(`\n  ${signal} — останавливаю сервер...`);
    server.close(() => {
      try { require('./lib/db').close(); } catch { /* уже закрыта */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return url;
}

main().catch((e) => {
  console.error('\nНе удалось запустить сервер:\n', e);
  process.exit(1);
});