/* ============================================================================
   PC BUILDER — конфигуратор.
   Три экрана: сборка в 1 клик → каталог (ручная подборка) → моя сборка и заказ.
   Каталог приходит из БД (/api/catalog), подбор — с сервера (/api/quick-build):
   алгоритм один и тот же, поэтому «собрать за клик» и «собрать руками» дают
   одинаково совместимые конфигурации.
   ========================================================================== */

/* ------------------------------- Справочник ------------------------------- */
const CATEGORIES = [
  { tag: 'CPU',         ru: 'Процессор',          icon: 'cpu.png',         color: '#8B5CF6' },
  { tag: 'Motherboard', ru: 'Материнская плата',  icon: 'motherboard.png', color: '#6366F1' },
  { tag: 'GPU',         ru: 'Видеокарта',         icon: 'gpu.png',         color: '#EC4899' },
  { tag: 'RAM',         ru: 'Оперативная память', icon: 'ram.png',         color: '#06B6D4' },
  { tag: 'Storage',     ru: 'Накопитель',         icon: 'storage.png',     color: '#10B981' },
  { tag: 'PSU',         ru: 'Блок питания',       icon: 'psu.png',         color: '#F59E0B' },
  { tag: 'Cooler',      ru: 'Охлаждение',         icon: 'cooler.png',      color: '#3B82F6' },
  { tag: 'Case',        ru: 'Корпус',             icon: 'pc_case.png',     color: '#94A3B8' },
];

const CAT_BY_TAG = Object.fromEntries(CATEGORIES.map((c) => [c.tag, c]));
const tagOf = (raw) => {
  const s = String(raw || '').toLowerCase();
  const found = CATEGORIES.find((c) => c.tag.toLowerCase() === s || c.ru.toLowerCase() === s);
  return found ? found.tag : raw;
};

const DELIVERY_ICONS = { pickup: '🏠', courier: '🚲', cdek: '📦', post: '📮' };
const PAY_ICONS = { card: '💳', sbp: '⚡', invoice: '🏦', cash: '💵' };

/* -------------------------------- Состояние ------------------------------- */
const STORE = { build: 'pcb2.build', theme: 'pcb.builder.theme', profile: 'pcb2.profile', budget: 'pcb2.budget' };

const load = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
};

const state = {
  page: 'quick',
  category: null,
  profiles: [],
  catalog: [],
  build: load(STORE.build, []),
  profileId: load(STORE.profile, 'gaming'),
  budget: load(STORE.budget, 130000),
  delivery: 'courier',
  search: '',
  sort: 'asc',
  compatibleOnly: true,
  result: null,
  loading: false,
  busy: false,
  user: null,
  fees: { assembly: 0, delivery: {} },
  deliveryTypes: {},
  paymentMethods: {},
};

const $ = (sel, root = document) => root.querySelector(sel);
const money = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');
const price = (v) => `${money(v)} ₽`;
const pct = (v) => `${Math.round(v)}%`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка запроса (${res.status})`);
  return data;
}

/* --------------------------- Приведение форматов --------------------------- */
/** Каталог и подбор отдают поля по-разному — приводим к одному виду. */
function normalize(raw) {
  const specs = raw.Specs || raw.specs || {};
  return {
    Id: raw.Id ?? raw.id,
    ComponentId: raw.ComponentId ?? raw.componentId ?? null,
    Category: tagOf(raw.Category ?? raw.category),
    Name: raw.Name ?? raw.name ?? '',
    Image: raw.Image ?? raw.image ?? '',
    Price: Number(raw.Price ?? raw.price ?? 0),
    Description: raw.Description ?? raw.description ?? '',
    Brand: raw.Brand ?? raw.brand ?? '',
    Socket: raw.Socket ?? raw.socket ?? '',
    RamType: raw.RamType ?? raw.ramType ?? '',
    TDP: Number(raw.TDP ?? raw.tdp ?? 0) || 0,
    Wattage: Number(raw.Wattage ?? raw.wattage ?? 0) || 0,
    PerformanceIndex: Number(raw.PerformanceIndex ?? raw.performanceIndex ?? 0) || 0,
    Cores: Number(raw.Cores ?? raw.cores ?? 0) || 0,
    MemoryGB: Number(raw.MemoryGB ?? raw.memoryGB ?? 0) || 0,
    CapacityGB: Number(raw.CapacityGB ?? raw.capacityGB ?? 0) || 0,
    FormFactor: raw.FormFactor ?? raw.formFactor ?? '',
    Efficiency: raw.Efficiency ?? raw.efficiency ?? '',
    CoolerType: raw.CoolerType ?? raw.coolerType ?? '',
    IGPU: (raw.IGPU ?? specs.igpu) === true,
    Sockets: raw.Sockets ?? specs.sockets ?? [],
    Supported: raw.Supported ?? specs.supported ?? [],
    Height: Number(raw.Height ?? specs.height ?? 0) || 0,
    MaxGpuLength: Number(raw.MaxGpuLength ?? specs.max_gpu_length ?? 0) || 0,
    MaxCoolerHeight: Number(raw.MaxCoolerHeight ?? specs.max_cooler_height ?? 0) || 0,
    Length: Number(raw.Length ?? raw.length ?? 0) || 0,
    Speed: Number(raw.Speed ?? raw.speed ?? 0) || 0,
    Interface: raw.Interface ?? raw.interface ?? '',
    Tags: raw.Tags ?? raw.tags ?? [],
    Stock: Number(raw.Stock ?? raw.stock ?? 0) || 0,
  };
}

const catalogItems = () => state.catalog;
const byCategory = (tag) => catalogItems().filter((c) => c.Category === tag);
const buildItem = (tag) => state.build.find((c) => c.Category === tag);
const partsTotal = () => state.build.reduce((s, c) => s + c.Price, 0);

/* ------------------------------ Совместимость ------------------------------ */
/** Та же логика, что на сервере: сокет, память, мощность, корпус, охлаждение. */
function checkBuild(items = state.build) {
  const get = (tag) => items.find((c) => c.Category === tag);
  const cpu = get('CPU');
  const mb = get('Motherboard');
  const ram = get('RAM');
  const gpu = get('GPU');
  const psu = get('PSU');
  const pcCase = get('Case');
  const cooler = get('Cooler');

  const issues = [];
  const need = [];
  if (!cpu) need.push('процессор');
  if (!mb) need.push('материнскую плату');
  if (!ram) need.push('оперативную память');
  if (!psu) need.push('блок питания');
  if (!gpu && !(cpu && cpu.IGPU)) need.push('видеокарту');
  if (need.length) {
    return { ok: false, complete: false, issues: [`Не хватает: ${need.join(', ')}`] };
  }

  if (cpu.Socket && mb.Socket && cpu.Socket !== mb.Socket) {
    issues.push(`Сокеты не совпадают: процессор ${cpu.Socket}, плата ${mb.Socket}`);
  }
  if (mb.RamType && ram.RamType && mb.RamType !== ram.RamType) {
    issues.push(`Тип памяти не совпадает: плата ${mb.RamType}, память ${ram.RamType}`);
  }
  if (mb.MaxMemoryGB && ram.MemoryGB && ram.MemoryGB > mb.MaxMemoryGB) {
    issues.push(`Плата поддерживает до ${mb.MaxMemoryGB} ГБ, выбрано ${ram.MemoryGB} ГБ`);
  }
  const draw = (cpu.TDP || 0) + (gpu ? gpu.TDP || 0 : 0) + 60;
  if (psu.Wattage && draw > psu.Wattage) issues.push(`Блок питания слабее: нужно ~${draw} Вт, стоит ${psu.Wattage} Вт`);
  if (pcCase && mb.FormFactor && pcCase.Supported.length && !pcCase.Supported.includes(mb.FormFactor)) {
    issues.push(`Корпус не поддерживает ${mb.FormFactor}`);
  }
  if (pcCase && gpu && pcCase.MaxGpuLength && gpu.Length > pcCase.MaxGpuLength) {
    issues.push(`Видеокарта длиннее, чем позволяет корпус (${gpu.Length} > ${pcCase.MaxGpuLength} мм)`);
  }
  if (cooler && cpu.Socket && cooler.Sockets.length && !cooler.Sockets.includes(cpu.Socket)) {
    issues.push(`Кулер не подходит к сокету ${cpu.Socket}`);
  }
  if (cooler && cpu.TDP && cooler.TDP && cooler.TDP < cpu.TDP) {
    issues.push(`Кулер слабее процессора: ${cooler.TDP} Вт против ${cpu.TDP} Вт`);
  }
  if (cooler && pcCase && cooler.CoolerType === 'air' && cooler.Height && pcCase.MaxCoolerHeight && cooler.Height > pcCase.MaxCoolerHeight) {
    issues.push(`Кулер не влезет по высоте: ${cooler.Height} > ${pcCase.MaxCoolerHeight} мм`);
  }

  return { ok: issues.length === 0, complete: true, issues, draw };
}

/** Подходит ли деталь к текущей корзине (для фильтра каталога). */
function itemConflicts(item) {
  const other = state.build.filter((c) => c.Category !== item.Category);
  const test = checkBuild([...other, item]);
  return test.complete ? test.issues : [];
}

/* ------------------------------- Сборка в 1 клик ------------------------------ */
function profileById(id) {
  return state.profiles.find((p) => p.id === id) || state.profiles[1] || state.profiles[0];
}

function applyAccent(profile) {
  const root = document.documentElement;
  if (profile) {
    root.style.setProperty('--accent', profile.accent);
    root.style.setProperty('--accent-2', shade(profile.accent, 26));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-2');
  }
}

/** Осветление/затемнение HEX-цвета — для второго цвета градиента. */
function shade(hex, percent) {
  const n = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amt));
  const b = Math.min(255, Math.max(0, (n & 255) + amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

async function runQuickBuild() {
  state.loading = true;
  state.result = null;
  render();
  try {
    const res = await api(`/api/quick-build?budget=${state.budget}&profile=${state.profileId}&delivery=${state.delivery}`);
    state.result = {
      ...res,
      items: res.items.map(normalize),
      variants: (res.variants || []).map((v) => ({ ...v, items: v.items.map(normalize) })),
    };
    setTimeout(() => $('#result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  } catch (e) {
    toast(e.message || 'Не удалось подобрать сборку', 'warn');
  } finally {
    state.loading = false;
    render();
  }
}

function takeBuild(items) {
  state.build = items.map(normalize);
  save(STORE.build, state.build);
  toast('Сборка сохранена — можно доработать её вручную', 'success');
  go('build');
}

/* --------------------------------- Роутинг --------------------------------- */
function parseHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  if (raw.startsWith('catalog/')) return { page: 'catalog', category: decodeURIComponent(raw.slice(8)) };
  if (raw === 'catalog') return { page: 'catalog', category: null };
  if (raw === 'build') return { page: 'build', category: null };
  return { page: 'quick', category: null };
}

function go(page, category) {
  const hash = page === 'catalog'
    ? (category ? `#/catalog/${encodeURIComponent(category)}` : '#/catalog')
    : page === 'build' ? '#/build' : '#/quick';
  if (location.hash === hash) { route(); return; }
  location.hash = hash;
}

function route() {
  const r = parseHash();
  state.page = r.page;
  state.category = r.category || null;
  state.search = '';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================================== РЕНДЕР ================================== */
function render() {
  const root = $('#app');
  const views = { quick: viewQuick, catalog: viewCatalog, build: viewBuild };
  root.innerHTML = (views[state.page] || viewQuick)();
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.page === state.page);
  });
  const count = $('#nav-count');
  if (count) {
    count.textContent = state.build.length;
    count.hidden = state.build.length === 0;
  }
  if (state.page !== 'quick') applyAccent(null);
}

/* ------------------------------ Экран: 1 клик ------------------------------ */
function viewQuick() {
  const profile = profileById(state.profileId);
  applyAccent(profile);
  const min = profile.budget.min;
  const max = profile.budget.max;
  const step = profile.budget.step || 5000;
  const presets = buildPresets(min, max);

  return `
    <section class="hero">
      <div class="eyebrow">Конфигуратор · ${state.catalog.length} комплектующих в каталоге</div>
      <h1>Соберём ПК <span class="grad">под вас</span><br>за один клик</h1>
      <p class="hero-sub">
        Выберите, для чего нужен компьютер, и назовите бюджет. Мы подберём совместимые детали,
        посчитаем мощность и покажем, что система вытянет — без сокетов, чипов памяти и лишних вопросов.
      </p>
    </section>

    <section class="glass quick-panel">
      <div class="quick-head">
        <h2>1. Для чего нужен ПК</h2>
        <span class="muted" style="font-size:13px">Можно выбрать любой сценарий</span>
      </div>
      <div class="profile-grid">
        ${state.profiles.map((p) => `
          <button type="button" class="profile-card ${p.id === state.profileId ? 'is-active' : ''}"
                  style="--pc:${p.accent}" onclick="Quick.selectProfile('${p.id}')">
            <div class="pc-icon">${p.icon}</div>
            <div class="pc-title">${esc(p.title)}</div>
            <div class="pc-blurb">${esc(p.blurb)}</div>
            <div class="pc-range">${money(p.budget.min)} – ${money(p.budget.max)} ₽</div>
          </button>`).join('')}
      </div>

      <div class="budget">
        <div class="quick-head" style="margin-bottom:0">
          <h2>2. Бюджет</h2>
          <div class="budget-value">${money(state.budget)} <small>₽</small></div>
        </div>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${state.budget}"
               aria-label="Бюджет в рублях"
               oninput="Quick.setBudget(+this.value)" onchange="Quick.setBudget(+this.value)">
        <div class="chips">
          ${presets.map((v) => `<button type="button" class="chip ${v === state.budget ? 'is-active' : ''}" onclick="Quick.setBudget(${v})">${money(v)} ₽</button>`).join('')}
        </div>
        <div class="quick-actions">
          <button type="button" class="btn btn-lg" onclick="Quick.build()" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Подбираем детали…' : '⚡ Собрать за 1 клик'}
          </button>
          <span class="quick-hint">${esc(profile.detail)}</span>
        </div>
      </div>
    </section>

    ${state.loading ? '<div class="boot" style="min-height:22vh;margin-top:28px"><div class="boot-ring"></div><div class="muted">Сверяем совместимость…</div></div>' : ''}
    ${state.result && !state.loading ? viewResult(state.result) : ''}
  `;
}

function buildPresets(min, max) {
  const span = max - min;
  return [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((min + span * f) / 1000) * 1000);
}

function viewResult(res) {
  const items = res.items;
  const total = res.totals.total;
  const delta = total - res.budget;
  const profile = profileById(res.profile.id);
  const scoreRows = [
    ['Игры', res.scores.games],
    ['Монтаж видео', res.scores.montage],
    ['3D и рендер', res.scores.render3d],
    ['Офисные задачи', res.scores.office],
    ['Стрим', res.scores.stream],
  ];

  return `
    <section class="glass result" id="result">
      <div class="result-head">
        <div class="result-title">
          <div class="result-badge">${res.profile.icon || profile.icon || '🛠'}</div>
          <div>
            <h2>Сборка готова</h2>
            <p>${esc(res.profile.title)} · бюджет ${price(res.budget)} · ${items.length} деталей</p>
          </div>
        </div>
        <div class="result-price">
          <div class="amount ${delta > 0 ? 'over' : 'ok'}">${price(total)}</div>
          <div class="caption">
            ${delta > 0
              ? `на ${price(delta)} выше бюджета`
              : `в бюджете, запас ${price(-delta)}`}
            · комплектующие ${price(res.totals.parts)}
          </div>
        </div>
      </div>

      <div class="result-grid">
        <div>
          <div class="panel-title"><span>Что получится</span><span class="muted" style="font-weight:500">оценка по каталогу</span></div>
          <div class="score-list">
            ${scoreRows.map(([label, value]) => `
              <div class="score-row">
                <span class="score-label">${label}</span>
                <span class="score-track"><span class="score-fill" style="width:${Math.min(100, value)}%"></span></span>
                <span class="score-val">${Math.round(value)}</span>
              </div>`).join('')}
          </div>

          <div class="panel-title" style="margin-top:24px">
            <span>Примерный FPS${res.hasGpu ? '' : ' (встроенная графика)'}</span>
            <span class="muted" style="font-weight:500">средние значения</span>
          </div>
          ${res.hasGpu === false
            ? `<p class="muted" style="font-size:13px;margin-top:-6px">
                 Сборка без дискретной видеокарты: процессор тянет офисные задачи, браузер и видеозвонки.
                 Для игр добавьте видеокарту — подбор покажет, что изменится.
               </p>`
            : `<div class="fps-list">
                ${res.fps.map((f) => `
                  <div class="fps-row">
                    <span class="g">${esc(f.name)}<small>${esc(f.preset)} · ${esc(f.res)}</small></span>
                    <span class="v ${f.value == null ? 'low' : f.value >= 60 ? 'high' : ''}">${f.value == null ? '—' : `${f.value} fps`}</span>
                  </div>`).join('')}
              </div>`}
        </div>

        <div>
          <div class="panel-title"><span>Питание и запас</span></div>
          <div class="power-meter">
            <div class="power-head">
              <span>Потребление ${res.power.draw} Вт</span>
              <span>Блок питания ${(items.find((i) => i.Category === 'PSU') || {}).Wattage || 0} Вт</span>
            </div>
            <div class="power-track">
              <div class="power-fill ${res.headroom < 20 ? 'warn' : ''}" style="width:${Math.min(100, 100 - res.headroom)}%"></div>
            </div>
          </div>

          <ul class="notes">
            ${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
          </ul>

          <div class="alert alert-ok" style="margin-top:18px">
            <span>✅</span>
            <span>${esc(res.compatibility.message)}: сокеты, тип памяти, мощность и габариты проверены.</span>
          </div>

          ${res.variants && res.variants.length ? `
            <div class="panel-title" style="margin-top:22px"><span>Другие варианты</span></div>
            <div class="variants">
              ${res.variants.map((v, i) => `
                <button type="button" class="variant-btn" onclick="Quick.takeVariant(${i})">
                  <b>${esc(v.key === 'economy' ? '🪙 Эконом' : '🚀 Мощнее')}</b>
                  <span>${price(v.total)} — ${esc(v.headline)}</span>
                </button>`).join('')}
            </div>` : ''}
        </div>
      </div>

      <div class="panel-title" style="margin-top:26px"><span>Комплектующие</span><span class="muted" style="font-weight:500">${items.length} шт</span></div>
      <div class="parts">
        ${items.map((item) => viewPart(item)).join('')}
      </div>

      <div class="result-actions">
        <button type="button" class="btn btn-lg" onclick="Quick.take()">
          🛒 Взять эту сборку
        </button>
        <button type="button" class="btn btn-lg btn-quiet" onclick="Quick.toCatalog()">Подкрутить детали вручную →</button>
      </div>
    </section>`;
}

function viewPart(item) {
  const cat = CAT_BY_TAG[item.Category] || {};
  return `
    <div class="part">
      <div class="part-img"><img src="/builder/images/${esc(item.Image)}" alt="" loading="lazy" decoding="async"></div>
      <div class="part-body">
        <div class="part-cat">${esc(cat.ru || item.Category)}</div>
        <div class="part-name">${esc(item.Name)}</div>
        ${item.Description ? `<div class="part-desc">${esc(item.Description)}</div>` : ''}
        ${specChips(item).length ? `<div class="part-specs">${specChips(item).map((s) => `<span class="spec">${esc(s)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="part-right">
        <div class="part-price">${price(item.Price)}</div>
        ${item.Stock > 0
          ? `<span class="spec" style="border-color:color-mix(in srgb, var(--ok) 40%, transparent);color:var(--ok)">в наличии ${item.Stock}</span>`
          : `<span class="spec">под заказ</span>`}
      </div>
    </div>`;
}

/** Характеристики, которые действительно полезно показать под названием. */
function specChips(item) {
  const out = [];
  if (item.Category === 'CPU') {
    if (item.Socket) out.push(item.Socket);
    if (item.Cores) out.push(`${item.Cores} ядер`);
    if (item.TDP) out.push(`${item.TDP} Вт`);
  }
  if (item.Category === 'GPU') {
    if (item.MemoryGB) out.push(`${item.MemoryGB} ГБ видеопамяти`);
    if (item.TDP) out.push(`${item.TDP} Вт`);
    if (item.Length) out.push(`${item.Length} мм`);
  }
  if (item.Category === 'Motherboard') {
    if (item.Socket) out.push(item.Socket);
    if (item.RamType) out.push(item.RamType);
    if (item.FormFactor) out.push(item.FormFactor);
  }
  if (item.Category === 'RAM') {
    if (item.MemoryGB) out.push(`${item.MemoryGB} ГБ`);
    if (item.RamType) out.push(item.RamType);
    if (item.Speed) out.push(`${item.Speed} МГц`);
  }
  if (item.Category === 'Storage') {
    if (item.CapacityGB) out.push(`${item.CapacityGB >= 1000 ? `${item.CapacityGB / 1000} ТБ` : `${item.CapacityGB} ГБ`}`);
    if (item.Interface) out.push(item.Interface);
  }
  if (item.Category === 'PSU') {
    if (item.Wattage) out.push(`${item.Wattage} Вт`);
    if (item.Efficiency) out.push(item.Efficiency);
  }
  if (item.Category === 'Cooler') {
    if (item.TDP) out.push(`до ${item.TDP} Вт`);
    if (item.CoolerType === 'aio') out.push('СЖО');
    if (item.CoolerType === 'air') out.push('воздушный');
  }
  if (item.Category === 'Case') {
    if (item.FormFactor) out.push(item.FormFactor);
    if (item.MaxGpuLength) out.push(`видеокарта до ${item.MaxGpuLength} мм`);
  }
  return out.slice(0, 4);
}

/* ------------------------------ Экран: каталог ------------------------------ */
function viewCatalog() {
  if (!state.category) {
    return `
      <div class="eyebrow">Каталог</div>
      <h1 style="font-size:clamp(28px,4vw,40px);margin:10px 0 6px">Выберите категорию</h1>
      <p class="muted">Можно собирать вручную — совместимость проверяется на лету.</p>
      <div class="cat-grid">
        ${CATEGORIES.map((cat) => {
          const picked = buildItem(cat.tag);
          const count = byCategory(cat.tag).length;
          return `
            <button type="button" class="cat-tile ${picked ? 'is-filled' : ''}" style="--cat-color:${cat.color}"
                    onclick="Catalog.open('${cat.tag}')">
              <div class="tile-top">
                <img src="/builder/images/${cat.icon}" alt="" loading="lazy" decoding="async">
                <span class="tile-count">${count}</span>
              </div>
              <div class="tile-name">${cat.ru}</div>
              <div class="tile-picked">${picked ? esc(picked.Name) : 'не выбрано'}</div>
            </button>`;
        }).join('')}
      </div>`;
  }

  const cat = CAT_BY_TAG[state.category];
  let items = byCategory(state.category);

  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter((c) => c.Name.toLowerCase().includes(q) || (c.Description || '').toLowerCase().includes(q));
  }
  if (state.sort === 'asc') items = items.slice().sort((a, b) => a.Price - b.Price);
  if (state.sort === 'desc') items = items.slice().sort((a, b) => b.Price - a.Price);
  if (state.sort === 'power') items = items.slice().sort((a, b) => (b.PerformanceIndex || 0) - (a.PerformanceIndex || 0));

  return `
    <div class="toolbar">
      <button type="button" class="btn btn-quiet" onclick="Catalog.back()">← Все категории</button>
      <div class="search">
        <span class="icon">🔍</span>
        <input type="search" placeholder="Поиск по названию…" value="${esc(state.search)}" oninput="Catalog.search(this.value)">
      </div>
      <label class="switch">
        <input type="checkbox" ${state.compatibleOnly ? 'checked' : ''} onchange="Catalog.toggleCompat(this.checked)">
        <span class="track"></span>
        <span>только совместимые</span>
      </label>
      <div class="chips">
        <button type="button" class="chip ${state.sort === 'asc' ? 'is-active' : ''}" onclick="Catalog.sort('asc')">Сначала дешёвые</button>
        <button type="button" class="chip ${state.sort === 'desc' ? 'is-active' : ''}" onclick="Catalog.sort('desc')">Сначала дорогие</button>
        <button type="button" class="chip ${state.sort === 'power' ? 'is-active' : ''}" onclick="Catalog.sort('power')">По мощности</button>
      </div>
    </div>

    <div class="panel-title" style="margin-top:8px">
      <span>${esc(cat ? cat.ru : state.category)}</span>
      <span class="muted" style="font-weight:500">${items.length} позиций</span>
    </div>

    ${items.length ? items.map((item) => viewComp(item)).join('')
      : '<div class="empty">Ничего не найдено — попробуйте другой запрос</div>'}`;
}

function viewComp(item) {
  const picked = buildItem(item.Category)?.Id === item.Id;
  const conflicts = state.compatibleOnly && state.build.length && !picked ? itemConflicts(item) : [];
  const blocked = conflicts.length > 0;
  return `
    <div class="comp-row ${picked ? 'is-picked' : ''} ${blocked ? 'is-blocked' : ''}">
      <div class="comp-img"><img src="/builder/images/${esc(item.Image)}" alt="" loading="lazy" decoding="async"></div>
      <div>
        <div class="comp-name">${esc(item.Name)}</div>
        ${item.Description ? `<div class="comp-desc">${esc(item.Description)}</div>` : ''}
        ${specChips(item).length ? `<div class="comp-specs">${specChips(item).map((s) => `<span class="spec">${esc(s)}</span>`).join('')}</div>` : ''}
        ${blocked ? `<div class="badge-ok badge-warn">⚠ ${esc(conflicts[0])}</div>` : ''}
        ${!blocked && !picked && state.build.length ? '<div class="badge-ok">✓ совместимо с текущей сборкой</div>' : ''}
      </div>
      <div class="comp-right">
        <div class="comp-price">${price(item.Price)}</div>
        <button type="button" class="mini-btn ${picked ? 'is-picked' : ''}" onclick="Catalog.pick(${item.Id})">
          ${picked ? '✓ Выбрано' : 'В сборку'}
        </button>
      </div>
    </div>`;
}

/* ----------------------------- Экран: моя сборка ----------------------------- */
function viewBuild() {
  if (!state.build.length) {
    return `
      <div class="eyebrow">Моя сборка</div>
      <h1 style="font-size:clamp(28px,4vw,40px);margin:10px 0 6px">Пока пусто</h1>
      <p class="muted">Соберите ПК в один клик или подберите детали по категориям.</p>
      <div class="empty" style="margin-top:24px">
        <div style="font-size:34px;margin-bottom:10px">🧩</div>
        <div style="margin-bottom:16px">Здесь появится готовая конфигурация</div>
        <button type="button" class="btn" onclick="Quick.go('quick')">Собрать за 1 клик</button>
      </div>`;
  }

  const compat = checkBuild();
  const parts = partsTotal();
  const assembly = Number(state.fees.assembly) || 0;
  const delivery = Number((state.fees.delivery || {})[state.delivery]) || 0;
  const draw = (buildItem('CPU')?.TDP || 0) + (buildItem('GPU')?.TDP || 0) + 60;

  return `
    <div class="eyebrow">Моя сборка</div>
    <h1 style="font-size:clamp(28px,4vw,40px);margin:10px 0 18px">${state.build.length} деталей · ${price(parts + assembly + delivery)}</h1>

    <div class="build-grid">
      <div>
        ${compat.ok
          ? `<div class="alert alert-ok"><span>✅</span><span>Всё совместимо: сокеты, память, мощность БП и габариты корпуса проверены.</span></div>`
          : `<div class="alert alert-warn"><span>⚠️</span><span>${compat.issues.map(esc).join('<br>')}</span></div>`}
        ${state.build.map((item) => viewPart(item)).join('')}
      </div>

      <aside class="glass summary">
        <div class="panel-title"><span>Итого</span></div>
        <div class="sum-row"><span>Комплектующие</span><b>${price(parts)}</b></div>
        <div class="sum-row"><span>Сборка и тестирование</span><b>${price(assembly)}</b></div>
        <div class="sum-row"><span>Доставка (${esc(deliveryName(state.delivery))})</span><b>${price(delivery)}</b></div>
        <div class="sum-row"><span>Потребление системы</span><b>${draw} Вт</b></div>
        <div class="sum-total"><span>К оплате</span><b>${price(parts + assembly + delivery)}</b></div>

        <div style="display:grid;gap:10px;margin-top:18px">
          <button type="button" class="btn btn-block btn-lg" ${compat.ok ? '' : 'disabled'} onclick="Checkout.open()">Оформить заказ</button>
          <button type="button" class="btn btn-quiet" onclick="Quick.go('quick')">Собрать заново за 1 клик</button>
          <button type="button" class="btn btn-quiet" onclick="Catalog.clear()">Очистить сборку</button>
        </div>
      </aside>
    </div>`;
}

function deliveryName(id) {
  return (state.deliveryTypes && state.deliveryTypes[id]) || id;
}

/* ================================ ДЕЙСТВИЯ ================================ */
const Quick = {
  go,
  selectProfile(id) {
    state.profileId = id;
    save(STORE.profile, id);
    const p = profileById(id);
    state.budget = Math.min(Math.max(state.budget, p.budget.min), p.budget.max);
    save(STORE.budget, state.budget);
    render();
  },
  setBudget(v) {
    state.budget = v;
    save(STORE.budget, v);
    const slider = document.querySelector('input[type=range]');
    if (slider) slider.value = v;
    const box = $('.budget-value');
    if (box) box.innerHTML = `${money(v)} <small>₽</small>`;
    document.querySelectorAll('.budget .chip').forEach((c) => {
      c.classList.toggle('is-active', c.textContent.startsWith(money(v)));
    });
  },
  build: runQuickBuild,
  take() { if (state.result) takeBuild(state.result.items); },
  takeVariant(i) {
    const v = state.result && state.result.variants && state.result.variants[i];
    if (v) takeBuild(v.items);
  },
  toCatalog() {
    if (state.result) {
      state.build = state.result.items.map(normalize);
      save(STORE.build, state.build);
    }
    go('catalog');
  },
};

const Catalog = {
  open(tag) { go('catalog', tag); },
  back() { go('catalog'); },
  search(q) {
    state.search = q;
    render();
    const input = document.querySelector('.search input');
    if (input) { input.focus(); input.setSelectionRange(q.length, q.length); }
  },
  sort(v) {
    state.sort = state.sort === v ? 'asc' : v;
    render();
  },
  toggleCompat(v) { state.compatibleOnly = v; render(); },
  pick(id) {
    const item = state.catalog.find((c) => c.Id === id);
    if (!item) return;
    const existing = buildItem(item.Category);
    if (existing && existing.Id === id) {
      state.build = state.build.filter((c) => c.Category !== item.Category);
    } else {
      state.build = [...state.build.filter((c) => c.Category !== item.Category), item];
    }
    save(STORE.build, state.build);
    render();
  },
  clear() {
    state.build = [];
    save(STORE.build, state.build);
    render();
  },
};

/* ============================== ОФОРМЛЕНИЕ ЗАКАЗА ============================== */
const Checkout = {
  open() {
    const compat = checkBuild();
    if (!compat.ok) { toast(compat.issues[0] || 'Сборка не готова', 'warn'); return; }

    const u = state.user || {};
    const assembly = Number(state.fees.assembly) || 0;
    const deliveryOpts = Object.entries(state.deliveryTypes);
    const payOpts = Object.entries(state.paymentMethods);
    const firstDelivery = deliveryOpts[0] ? deliveryOpts[0][0] : 'courier';

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>Оформление заказа</h3>
        <p class="modal-sub">Сборка на ${price(partsTotal())} · сборка и тесты ${price(assembly)}. Оплата — в кабинете клиента.</p>

        <div class="panel-title"><span>Способ получения</span></div>
        <div class="choice-row">
          ${deliveryOpts.map(([k, v], i) => `
            <label class="choice">
              <input type="radio" name="d" value="${esc(k)}" data-fee="${Number((state.fees.delivery || {})[k]) || 0}" ${i === 0 ? 'checked' : ''}>
              <span class="dot"></span>
              <span>
                <span class="c-title">${DELIVERY_ICONS[k] || '📦'} ${esc(v)}</span>
                <span class="c-sub">${Number((state.fees.delivery || {})[k]) ? price((state.fees.delivery || {})[k]) : 'бесплатно'}</span>
              </span>
            </label>`).join('')}
        </div>

        <div class="panel-title"><span>Способ оплаты</span></div>
        <div class="choice-row">
          ${payOpts.map(([k, v], i) => `
            <label class="choice">
              <input type="radio" name="p" value="${esc(k)}" ${i === 0 ? 'checked' : ''}>
              <span class="dot"></span>
              <span>
                <span class="c-title">${PAY_ICONS[k] || '💰'} ${esc(v)}</span>
                <span class="c-sub">${k === 'cash' ? 'при получении' : 'сразу после оформления'}</span>
              </span>
            </label>`).join('')}
        </div>

        <div class="panel-title" style="margin-top:22px"><span>Кому и куда</span></div>
        <div class="fields-2">
          <div class="field"><label>Получатель</label><input id="co-name" value="${esc(u.name || '')}" placeholder="Иван Иванов"></div>
          <div class="field"><label>Телефон</label><input id="co-phone" value="${esc(u.phone || '')}" placeholder="+79990000000"></div>
          <div class="field"><label>Город</label><input id="co-city" value="${esc(u.city || '')}" placeholder="Москва"></div>
          <div class="field"><label>Адрес</label><input id="co-address" value="${esc(u.address || '')}" placeholder="ул. Тверская, 7"></div>
        </div>
        <div class="field"><label>Комментарий мастеру</label><input id="co-note" placeholder="тихая сборка, только проверенные детали"></div>

        <div class="sum-row" style="justify-content:flex-end;gap:20px">
          <span>К оплате</span>
          <b id="co-total" style="font-size:22px">${price(partsTotal() + assembly + (state.fees.delivery[firstDelivery] || 0))}</b>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn btn-quiet" data-close>Отмена</button>
          <button type="button" class="btn" id="co-submit">Оформить заказ</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const val = (sel) => $(sel, overlay).value.trim();
    overlay.querySelectorAll('input[name=d]').forEach((r) => r.addEventListener('change', () => {
      state.delivery = r.value;
      const total = partsTotal() + assembly + (Number(r.dataset.fee) || 0);
      $('#co-total', overlay).textContent = price(total);
    }));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.hasAttribute('data-close')) close();
    });
    $('#co-submit', overlay).addEventListener('click', () => submit(overlay, {
      deliveryType: (overlay.querySelector('input[name=d]:checked') || {}).value || 'courier',
      paymentMethod: (overlay.querySelector('input[name=p]:checked') || {}).value || 'card',
      recipient: val('#co-name'),
      recipientPhone: val('#co-phone'),
      city: val('#co-city'),
      address: val('#co-address'),
      comment: val('#co-note'),
    }));

    function close() {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 220);
    }
  },
};

async function submit(overlay, payload) {
  const btn = $('#co-submit', overlay);
  btn.disabled = true;
  btn.textContent = 'Отправляем…';
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: state.build.map((c) => ({ sourceId: c.Id, name: c.Name, qty: 1 })),
        comment: payload.comment || 'Сборка подобрана конфигуратором',
        ...payload,
      }),
    });
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 220);
    Catalog.clear();
    toast(`Заказ ${res.order.order_no} оформлен — оплатите в кабинете`, 'success');
    if (state.user) setTimeout(() => { location.href = '/client'; }, 900);
    else showModal('Нужен вход в кабинет', 'Сборка сохранена. Войдите в кабинет клиента, чтобы оплатить заказ и следить за сборкой.');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Оформить заказ';
    if (String(e.message).includes('вход') || String(e.message).includes('Требуется')) {
      showModal('Нужен вход в кабинет', 'Войдите в кабинет клиента, чтобы оформить заказ. Сборка сохранится — ничего не придётся выбирать заново.', 'Войти', () => { location.href = '/client'; });
    } else {
      toast(e.message || 'Не удалось оформить заказ', 'warn');
    }
  }
}

function showModal(title, text, actionText, onAction) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <h3>${esc(title)}</h3>
      <p class="modal-sub">${esc(text)}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-quiet" data-close>Понятно</button>
        ${actionText ? `<button type="button" class="btn" data-go>${esc(actionText)}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.hasAttribute('data-close')) overlay.remove();
    if (e.target.hasAttribute('data-go')) { overlay.remove(); if (onAction) onAction(); }
  });
}

/* ================================== TOAST ================================== */
let toastTimer = null;
function toast(msg, type = 'success') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    $('#toast-root').appendChild(el);
  }
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ================================== ТЕМА ================================== */
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(STORE.theme, next);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#08080F' : '#F4F5FA');
}

/* =================================== INIT =================================== */
window.addEventListener('hashchange', route);

document.addEventListener('DOMContentLoaded', async () => {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (btn) go(btn.dataset.page);
  });
  $('#theme-btn').addEventListener('click', toggleTheme);

  try {
    const [meta, profiles, catalog] = await Promise.all([
      api('/api/meta'),
      api('/api/profiles'),
      api('/api/catalog'),
    ]);
    state.fees = meta.fees || state.fees;
    state.deliveryTypes = meta.deliveryTypes || {};
    state.paymentMethods = meta.paymentMethods || {};
    state.profiles = profiles.profiles || [];
    state.catalog = (catalog || []).map(normalize);
    if (!state.profiles.some((p) => p.id === state.profileId)) state.profileId = 'gaming';

    // Ссылка с лендинга или из кабинета: ?profile=3d&budget=250000 —
    // подставляем сценарий и бюджет, сразу показываем подобранную сборку.
    const params = new URLSearchParams(location.search);
    const deepProfile = params.get('profile');
    const deepBudget = Number(params.get('budget'));
    const p = profileById(state.profileId);
    if (deepProfile && state.profiles.some((x) => x.id === deepProfile)) {
      state.profileId = deepProfile;
      save(STORE.profile, deepProfile);
    }
    const range = profileById(state.profileId).budget;
    state.budget = Number.isFinite(deepBudget) && deepBudget > 0
      ? Math.min(Math.max(Math.round(deepBudget / 1000) * 1000, range.min), range.max)
      : Math.min(Math.max(state.budget, range.min), range.max);
    save(STORE.budget, state.budget);
    if (deepProfile || deepBudget) setTimeout(runQuickBuild, 120);
  } catch (e) {
    $('#app').innerHTML = `<div class="empty">Не удалось загрузить каталог: ${esc(e.message)}</div>`;
    return;
  }

  try {
    const me = await api('/api/auth/me');
    state.user = me.user && me.user.type === 'client' ? me.user : null;
  } catch (e) { /* не авторизован — это нормально */ }

  // Сохранённая сборка могла устареть: сверяем с текущим каталогом.
  if (state.build.length) {
    state.build = state.build
      .map((item) => state.catalog.find((c) => c.Id === item.Id))
      .filter(Boolean);
    save(STORE.build, state.build);
  }

  const r = parseHash();
  state.page = r.page;
  state.category = r.category;
  render();
});

window.Quick = Quick;
window.Catalog = Catalog;
window.Checkout = Checkout;