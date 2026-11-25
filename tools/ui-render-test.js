/**
 * Проверка интерфейса конфигуратора без браузера: подставляем минимальный DOM,
 * отдаём каталог из data.js и прогоняем рендер всех экранов.
 * Дополнительно проверяем качество самого каталога (дубли, полнота названий, характеристики).
 *
 * Запуск: node tools/ui-render-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const { COMPONENTS, CATEGORY_LIST } = (() => {
  const raw = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
  return new Function(`${raw}\nreturn { COMPONENTS, CATEGORY_LIST };`)();
})();

/* --------------------------- каталог в формате API --------------------------- */
const SPEC_KEYS = {
  Sockets: 'Sockets', Supported: 'Supported', Height: 'Height', Radiator: 'Radiator',
  MaxGpuLength: 'MaxGpuLength', MaxCoolerHeight: 'MaxCoolerHeight', Modular: 'Modular',
  DriveType: 'DriveType', ReadSpeed: 'ReadSpeed', IGPU: 'IGPU',
};
const toApiItem = (c) => {
  const specs = {};
  for (const [api, src] of Object.entries(SPEC_KEYS)) {
    if (c[src] === undefined || c[src] === null) continue;
    const key = api === 'IGPU' ? 'igpu' : api.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    specs[key] = c[src];
  }
  return {
    Id: c.Id, ComponentId: c.Id, Category: c.Category, Name: c.Name, Image: c.Image,
    Price: c.Price, Description: c.Description, Brand: c.Brand, Socket: c.Socket || '',
    RamType: c.RamType || '', TDP: c.TDP || 0, Wattage: c.Wattage || 0,
    PerformanceIndex: c.PerformanceIndex || 0, Cores: c.Cores || 0, Threads: c.Threads || 0,
    MemoryGB: c.MemoryGB || 0, CapacityGB: c.CapacityGB || 0, FormFactor: c.FormFactor || '',
    Interface: c.Interface || '', Efficiency: c.Efficiency || '', CoolerType: c.CoolerType || '',
    MaxMemoryGB: c.MaxMemoryGB || 0, Length: c.Length || 0, Modules: c.Modules || 0,
    Speed: c.Speed || 0, Tags: c.Tags || [], Specs: specs, Stock: 3 + (c.Id % 9), Reserved: 0,
  };
};
const CATALOG = COMPONENTS.map(toApiItem);

/* ---------------------------------- DOM-заглушка ---------------------------------- */
function el(tag = 'div') {
  return {
    tagName: tag, innerHTML: '', textContent: '', className: '', dataset: {}, children: [],
    value: '', disabled: false,
    style: { setProperty() { }, colorScheme: '' },
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() { }, removeEventListener() { },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() { }, setAttribute() { }, getAttribute() { return null; }, remove() { },
    scrollIntoView() { }, setSelectionRange() { },
  };
}
const appEl = el();
const handlers = {};
const documentStub = {
  documentElement: { style: { setProperty() { }, removeProperty() { } }, getAttribute() { return 'dark'; } },
  body: el('body'),
  getElementById: (id) => (id === 'app' ? appEl : el()),
  querySelector: (sel) => (sel === '#app' ? appEl : /^#/.test(sel || '') ? el() : null),
  querySelectorAll: () => [],
  createElement: (tag) => el(tag),
  addEventListener(type, fn) { handlers[type] = fn; },
  removeEventListener() { },
};

const storage = new Map();
const responses = {
  '/api/meta': {
    fees: { assembly: 3000, delivery: { pickup: 0, courier: 800, cdek: 500, post: 350 } },
    deliveryTypes: { pickup: 'Самовывоз', courier: 'Курьер', cdek: 'СДЭК', post: 'Почта' },
    paymentMethods: { card: 'Карта', sbp: 'СБП', invoice: 'Счёт', cash: 'Наличные' },
  },
  '/api/profiles': { profiles: [], categories: CATEGORY_LIST },
  '/api/catalog': CATALOG,
  '/api/auth/me': { user: null },
};

const sandbox = {
  console,
  document: documentStub,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  },
  location: { hash: '', search: '', href: 'http://localhost/builder' },
  history: { pushState() { } },
  URLSearchParams,
  setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => fn(),
  fetch: async (url) => {
    const key = String(url).split('?')[0];
    const data = responses[key];
    if (data === undefined) return { ok: false, status: 404, json: async () => ({ error: 'нет такого маршрута' }) };
    return { ok: true, status: 200, json: async () => data };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.scrollTo = () => { };
sandbox.window.addEventListener = () => { };
sandbox.requestAnimationFrame = sandbox.requestAnimationFrame;

const ctx = vm.createContext(sandbox);
// Экспортируем внутренние функции для проверок (в браузере они скрыты в модульной области)
vm.runInContext(`${appSrc}\n;globalThis.__api = { state, render, checkBuild, normalize, go };`,
  ctx, { filename: 'app.js' });

/* ---------------------------------- Проверки ---------------------------------- */
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const api = sandbox.__api;

/* 0. Качество каталога */
{
  const byCat = {};
  CATALOG.forEach((c) => { byCat[c.Category] = (byCat[c.Category] || 0) + 1; });
  check('каталог: 8 категорий', Object.keys(byCat).length === 8, JSON.stringify(byCat));
  check('каталог: больше 140 позиций', CATALOG.length > 140, CATALOG.length + ' шт');

  const dups = [];
  const seen = new Set();
  for (const c of CATALOG) {
    const key = `${c.Category}|${c.Name.toLowerCase()}`;
    if (seen.has(key)) dups.push(c.Name);
    seen.add(key);
  }
  check('каталог: нет дублей названий', dups.length === 0, dups.slice(0, 4).join(', '));

  check('каталог: названия не обрезаны', CATALOG.every((c) => c.Name.length >= 8));
  check('каталог: у всех есть описание', CATALOG.every((c) => (c.Description || '').length > 8));
  check('каталог: цены положительные', CATALOG.every((c) => c.Price > 0));
  check('каталог: CPU с сокетом', CATALOG.filter((c) => c.Category === 'CPU').every((c) => c.Socket));
  check('каталог: CPU с числом ядер', CATALOG.filter((c) => c.Category === 'CPU').every((c) => c.Cores > 0));
  check('каталог: платы с сокетом и типом памяти',
    CATALOG.filter((c) => c.Category === 'Motherboard').every((c) => c.Socket && c.RamType));
  check('каталог: GPU с видеопамятью', CATALOG.filter((c) => c.Category === 'GPU').every((c) => c.MemoryGB >= 4));
  check('каталог: GPU с длиной корпуса', CATALOG.filter((c) => c.Category === 'GPU').every((c) => c.Length > 0));
  check('каталог: БП с мощностью', CATALOG.filter((c) => c.Category === 'PSU').every((c) => c.Wattage >= 400));
  check('каталог: кулеры со списком сокетов',
    CATALOG.filter((c) => c.Category === 'Cooler').every((c) => (c.Specs.sockets || []).length > 0));
  check('каталог: корпуса поддерживают платы',
    CATALOG.filter((c) => c.Category === 'Case').every((c) => (c.Specs.supported || []).length > 0));
  check('каталог: накопители с объёмом', CATALOG.filter((c) => c.Category === 'Storage').every((c) => c.CapacityGB > 0));
  check('каталог: картинки существуют',
    CATALOG.every((c) => fs.existsSync(path.join(ROOT, 'images', c.Image))),
    CATALOG.filter((c) => !fs.existsSync(path.join(ROOT, 'images', c.Image))).map((c) => c.Image).join(', '));
}

/* 1. Инициализация */
(async () => {
  // Подставляем сценарии (как это делает /api/profiles)
  responses['/api/profiles'].profiles = [
    { id: 'office', title: 'Офис и учёба', icon: '📄', accent: '#22D3EE', blurb: 'x', detail: 'y', budget: { min: 45000, max: 130000, step: 5000, default: 65000 } },
    { id: 'gaming', title: 'Игровая', icon: '🎮', accent: '#8B5CF6', blurb: 'x', detail: 'y', budget: { min: 70000, max: 350000, step: 5000, default: 130000 } },
    { id: '3d', title: '3D-моделирование', icon: '🧊', accent: '#F59E0B', blurb: 'x', detail: 'y', budget: { min: 130000, max: 550000, step: 5000, default: 230000 } },
  ];

  await handlers['DOMContentLoaded']();

  /* 2. Экран «Сборка в 1 клик» */
  check('quick: каталог загружен', api.state.catalog.length === CATALOG.length, `${api.state.catalog.length} из ${CATALOG.length}`);
  check('quick: сценарии отрисованы', (appEl.innerHTML.match(/class="profile-card/g) || []).length === 3);
  check('quick: слайдер бюджета', appEl.innerHTML.includes('type="range"'));
  check('quick: кнопка 1 клик', appEl.innerHTML.includes('Собрать за 1 клик'));
  check('quick: пресеты бюджета', appEl.innerHTML.includes('class="chip'));

  /* 3. Каталог: список категорий */
  api.state.page = 'catalog';
  api.state.category = null;
  api.render();
  check('catalog: 8 плиток категорий', (appEl.innerHTML.match(/class="cat-tile/g) || []).length === 8);

  /* 4. Категория: названия показываются целиком */
  let imgMissing = [];
  let rows = 0;
  for (const c of ['CPU', 'GPU', 'PSU', 'RAM', 'Cooler', 'Motherboard', 'Case', 'Storage']) {
    api.state.page = 'catalog';
    api.state.category = c;
    api.state.search = '';
    api.render();
    const html = appEl.innerHTML;
    rows += (html.match(/class="comp-row/g) || []).length;
    for (const m of html.matchAll(/src="\/builder\/images\/([^"]+)"/g)) {
      if (!fs.existsSync(path.join(ROOT, 'images', m[1]))) imgMissing.push(`${c}:${m[1]}`);
    }
  }
  check('catalog: строки во всех категориях', rows > 140, `строк ${rows}`);
  check('catalog: картинки на месте', imgMissing.length === 0, imgMissing.slice(0, 4).join(', '));

  const gpu = CATALOG.find((c) => c.Category === 'GPU');
  api.state.page = 'catalog';
  api.state.category = 'GPU';
  api.state.search = '';
  api.render();
  check('catalog: полное название в строке', appEl.innerHTML.includes(gpu.Name), gpu.Name);

  /* 5. Совместимость: конфликт сокета ловится */
  const pick = (c) => api.normalize(c);
  const cpu = pick(CATALOG.find((c) => c.Category === 'CPU' && c.Socket === 'AM4'));
  const badBoard = pick(CATALOG.find((c) => c.Category === 'Motherboard' && c.Socket === 'LGA1700'));
  const ram = pick(CATALOG.find((c) => c.Category === 'RAM'));
  const gpu2 = pick(CATALOG.find((c) => c.Category === 'GPU'));
  const psu = pick(CATALOG.find((c) => c.Category === 'PSU'));
  const pcCase = pick(CATALOG.find((c) => c.Category === 'Case'));
  const cooler = pick(CATALOG.find((c) => c.Category === 'Cooler'));

  const good = [cpu, badBoard, ram, gpu2, psu, pcCase, cooler];
  const res1 = api.checkBuild(good);
  check('совместимость: конфликт сокета найден', !res1.ok && /Сокет/i.test(res1.issues[0]), res1.issues[0] || '');

  const matchingBoard = CATALOG.find((c) => c.Category === 'Motherboard' && c.Socket === cpu.Socket && c.RamType === cpu.RamType);
  const good2 = [cpu, matchingBoard, ram, gpu2, psu, pcCase, cooler].filter(Boolean);
  const res2 = api.checkBuild(good2);
  check('совместимость: корректная сборка проходит', res2.ok, res2.issues.join('; '));

  /* 6. Экран «Моя сборка» */
  api.state.build = good2.map((c) => c);
  api.state.page = 'build';
  api.render();
  const buildHtml = appEl.innerHTML;
  check('build: детали отрисованы', (buildHtml.match(/class="part"/g) || []).length === good2.length);
  check('build: есть итог и кнопка заказа', buildHtml.includes('Оформить заказ') && buildHtml.includes('К оплате'));
  check('build: полное название процессора', buildHtml.includes(cpu.Name));

  api.state.build = [];
  api.state.page = 'build';
  api.render();
  check('build: пустое состояние', appEl.innerHTML.includes('Пока пусто'));

  /* 7. Готово */

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  console.log('');
  console.log(failed.length ? `❌ Провалено проверок: ${failed.length}` : `✅ Все проверки интерфейса пройдены (${results.length})`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('Ошибка теста:', e);
  process.exit(1);
});
