/* ============================================================================
   Кабинет клиента: заказы, оплата, этапы сборки, переписка, подтверждение получения.
   Вид переключается через хеш (#/orders, #/profile) — ссылку можно сохранить.
   ========================================================================== */
const {
  esc, money, moneyShort, date, ago, api, toast, modal, closeModal, confirmDialog,
  drawer, closeDrawer, meta, badge, payBadge, n2, plural, debounce, val, keepSearchFocus,
  empty, skeletonCards, skeletonRows, hashRouter, withBusy, copy, printDoc, trackLink,
} = PCB;

const state = {
  me: null,
  meta: null,
  orders: [],
  view: 'orders',
  filter: 'active',   // active | all | done
  q: '',
  sort: 'new',        // new | sum
};

/* ============================ Загрузка ============================ */
async function boot() {
  try {
    state.meta = await meta();
  } catch (e) {
    document.getElementById('app').innerHTML = empty('📡', 'Сервер недоступен', e.message);
    return;
  }
  let user = null;
  try {
    const r = await api('/api/auth/me');
    user = r.user;
  } catch (e) { /* не авторизован — покажем вход */ }

  if (!user || user.type !== 'client') {
    renderAuth();
    return;
  }

  state.me = user;
  document.getElementById('header').style.display = '';
  document.getElementById('who').textContent = state.me.name || 'Клиент';
  document.getElementById('avatar').textContent = (state.me.name || 'К').slice(0, 1).toUpperCase();
  PCB.theme.apply();

  await loadOrders();

  router = hashRouter({
    routes: { orders: renderOrders, profile: renderProfile },
    fallback: 'orders',
    onChange: (view) => { state.view = view; syncNav(); },
  });
  router.refresh();
}

async function loadOrders() {
  state.orders = await api('/api/orders/my');
}

function syncNav() {
  document.querySelectorAll('#nav [data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  const count = state.orders.filter((o) => ['new', 'paid', 'purchasing', 'assembling', 'testing', 'ready', 'shipped'].includes(o.status)).length;
  const btn = document.querySelector('#nav [data-view="orders"]');
  if (btn) btn.innerHTML = `Мои заказы${count ? ` <span class="nav-count">${count}</span>` : ''}`;
}

let router = null;

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
}

/* ============================ Авторизация ============================ */
function renderAuth() {
  document.getElementById('header').style.display = 'none';
  document.getElementById('app').innerHTML = `
    <div class="auth-page" style="min-height:100vh;margin:-22px -20px -64px">
      <div class="auth-wrap">
        <div class="auth-head">
          <div class="logo"><div class="logo-mark">PC</div> PCBuilder</div>
          <div class="auth-sub">Кабинет клиента: заказы, оплата, доставка</div>
        </div>
        <div class="card">
          <div class="seg mb-16" style="width:100%">
            <button class="active" style="flex:1" onclick="switchAuth('login')">Вход</button>
            <button style="flex:1" onclick="switchAuth('reg')">Регистрация</button>
          </div>
          <div id="auth-body"></div>
        </div>
        <div class="notice mt-16">
          <span class="n-icon">💡</span>
          <span>Пароль выдаёт мастерская при оформлении заказа. Забыли — позвоните нам.</span>
        </div>
        <div class="row gap-8 mt-16" style="justify-content:center">
          <a class="btn btn-sm btn-ghost" href="/">← На главную</a>
          <a class="btn btn-sm btn-ghost" href="/track">Отследить заказ</a>
        </div>
      </div>
    </div>`;
  switchAuth('login');
}

function switchAuth(mode) {
  const login = document.getElementById('tab-login');
  const reg = document.getElementById('tab-reg');
  if (login) login.classList.toggle('active', mode === 'login');
  if (reg) reg.classList.toggle('active', mode === 'reg');

  document.getElementById('auth-body').innerHTML = mode === 'login' ? `
    <form id="auth-form" autocomplete="on">
      <div class="field">
        <label for="lg-login">Телефон или email</label>
        <input id="lg-login" name="username" autocomplete="username" placeholder="+7 999 000-00-00">
      </div>
      <div class="field">
        <label for="lg-pass">Пароль</label>
        <input id="lg-pass" name="password" type="password" autocomplete="current-password" placeholder="••••••">
      </div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Войти</button>
    </form>`
    : `
    <form id="auth-form" autocomplete="on">
      <div class="form-grid">
        <div class="field full"><label for="rg-name">Имя и фамилия</label>
          <input id="rg-name" autocomplete="name" placeholder="Иван Иванов" required></div>
        <div class="field"><label for="rg-phone">Телефон</label>
          <input id="rg-phone" type="tel" autocomplete="tel" placeholder="+79990000000" required></div>
        <div class="field"><label for="rg-email">Email</label>
          <input id="rg-email" type="email" autocomplete="email" placeholder="mail@example.com"></div>
        <div class="field"><label for="rg-city">Город</label>
          <input id="rg-city" placeholder="Москва"></div>
        <div class="field"><label for="rg-pass">Пароль</label>
          <input id="rg-pass" type="password" autocomplete="new-password" placeholder="минимум 6 символов" required></div>
        <div class="field full"><label for="rg-addr">Адрес доставки</label>
          <input id="rg-addr" autocomplete="street-address" placeholder="ул. Тверская, 7, кв 15"></div>
      </div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Зарегистрироваться</button>
    </form>`;

  const form = document.getElementById('auth-form');
  form.onsubmit = (e) => { e.preventDefault(); mode === 'login' ? doLogin(e.submitter) : doRegister(e.submitter); };
}

async function doLogin(btn) {
  try {
    await withBusy(btn, () => api('/api/auth/login', {
      method: 'POST',
      body: { login: val('#lg-login'), password: val('#lg-pass') },
    }));
    toast('Добро пожаловать!', 'ok');
    boot();
  } catch (e) { toast(e.message, 'err'); }
}

async function doRegister(btn) {
  try {
    await withBusy(btn, () => api('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: val('#rg-name'), phone: val('#rg-phone'), email: val('#rg-email'),
        city: val('#rg-city'), address: val('#rg-addr'), password: val('#rg-pass'),
      },
    }));
    toast('Регистрация успешна — можно оформлять заказ', 'ok');
    boot();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ Заказы ============================ */
const ACTIVE = ['new', 'paid', 'purchasing', 'assembling', 'testing', 'ready', 'shipped'];

const stages = () => state.meta.orderStages || [
  { id: 'new', label: 'Оформлен', statuses: ['new'] },
  { id: 'paid', label: 'Оплачен', statuses: ['paid'] },
  { id: 'procure', label: 'Закупка', statuses: ['purchasing'] },
  { id: 'build', label: 'Сборка', statuses: ['assembling', 'testing'] },
  { id: 'ready', label: 'Готов', statuses: ['ready'] },
  { id: 'shipped', label: 'Доставка', statuses: ['shipped'] },
  { id: 'done', label: 'Получен', statuses: ['delivered', 'completed'] },
];

/** Индекс текущего шага клиента (−1 — отменён). */
function stageIndex(status) {
  const list = stages();
  if (status === 'cancelled') return -1;
  const i = list.findIndex((s) => s.statuses.includes(status));
  return i === -1 ? 0 : i;
}

function stepperHtml(status) {
  const list = stages();
  const idx = stageIndex(status);
  const cancelled = status === 'cancelled';
  return `<div class="stepper">${list.map((s, i) => {
    const cls = cancelled ? '' : i < idx ? 'done' : i === idx ? 'now' : '';
    return `<div class="step ${cls}">
      <span class="dot">${!cancelled && i < idx ? '✓' : ''}</span>
      <span class="step-label">${esc(s.label)}</span>
    </div>`;
  }).join('')}</div>`;
}

function filteredOrders() {
  const q = state.q.toLowerCase().trim();
  let list = state.orders.slice();
  if (state.filter === 'active') list = list.filter((o) => ACTIVE.includes(o.status));
  if (state.filter === 'done') list = list.filter((o) => !ACTIVE.includes(o.status));
  if (q) {
    list = list.filter((o) => {
      const statusLabel = (state.meta.statuses.find((s) => s.id === o.status) || {}).label || '';
      return `${o.order_no} ${o.comment || ''} ${o.track_number || ''} ${o.status} ${statusLabel} ${o.delivery_type || ''}`
        .toLowerCase()
        .includes(q);
    });
  }
  list.sort((a, b) => (state.sort === 'sum'
    ? n2(b.total) - n2(a.total)
    : n2(b.id) - n2(a.id)));
  return list;
}

/** Что именно ищет поле: номер, трек, комментарий или статус. */
const SEARCH_HINT = 'Номер заказа, трек-номер, комментарий или статус';

function summaryHtml() {
  const active = state.orders.filter((o) => ACTIVE.includes(o.status));
  const unpaid = active.filter((o) => o.payment_status !== 'paid');
  const shipped = state.orders.filter((o) => o.status === 'shipped');
  const sum = active.reduce((s, o) => s + n2(o.total), 0);
  return `
    <div class="grid grid-4 mb-16">
      <div class="stat" style="--stat-accent:var(--brand)">
        <div class="stat-icon">📋</div>
        <span class="stat-label">В работе</span>
        <span class="stat-value">${active.length}</span>
        <span class="stat-foot">${plural(active.length, 'заказ', 'заказа', 'заказов')} на ${moneyShort(sum)} ₽</span>
      </div>
      <div class="stat" style="--stat-accent:var(--warn)">
        <div class="stat-icon">💳</div>
        <span class="stat-label">Ждут оплаты</span>
        <span class="stat-value">${unpaid.length}</span>
        <span class="stat-foot">${unpaid.length ? money(unpaid.reduce((s, o) => s + n2(o.total), 0)) : 'всё оплачено'}</span>
      </div>
      <div class="stat" style="--stat-accent:var(--info)">
        <div class="stat-icon">🚚</div>
        <span class="stat-label">В доставке</span>
        <span class="stat-value">${shipped.length}</span>
        <span class="stat-foot">${shipped.length ? 'подтвердите получение' : 'нет активных отправлений'}</span>
      </div>
      <div class="stat" style="--stat-accent:var(--ok)">
        <div class="stat-icon">✅</div>
        <span class="stat-label">Завершено</span>
        <span class="stat-value">${state.orders.filter((o) => o.status === 'completed').length}</span>
        <span class="stat-foot">${state.orders.length} ${plural(state.orders.length, 'заказ', 'заказа', 'заказов')} всего</span>
      </div>
    </div>`;
}

function toolbarHtml() {
  const found = filteredOrders().length;
  const total = state.orders.length;
  return `
    <div class="card mb-16">
      <div class="row wrap-row gap-12">
        <div class="input-icon grow" style="min-width:220px">
          <span class="i">🔍</span>
          <input data-search-input placeholder="${SEARCH_HINT}"
                 value="${esc(state.q)}" oninput="onSearch(this.value)">
          ${state.q ? `<button class="icon-btn" title="Очистить (Esc)" onclick="clearSearch()" style="width:28px;height:28px;font-size:12px">✕</button>` : ''}
        </div>
        <div class="seg">
          <button class="${state.filter === 'active' ? 'active' : ''}" onclick="setFilter('active')">Активные</button>
          <button class="${state.filter === 'all' ? 'active' : ''}" onclick="setFilter('all')">Все</button>
          <button class="${state.filter === 'done' ? 'active' : ''}" onclick="setFilter('done')">Завершённые</button>
        </div>
        <div class="seg">
          <button class="${state.sort === 'new' ? 'active' : ''}" onclick="setSort('new')">Сначала новые</button>
          <button class="${state.sort === 'sum' ? 'active' : ''}" onclick="setSort('sum')">По сумме</button>
        </div>
      </div>
      ${state.q ? `<div class="small muted mt-8">Найдено ${found} из ${total}. Поиск идёт по номеру, треку, комментарию и статусу — Esc очищает поле.</div>` : ''}
    </div>`;
}

function clearSearch() {
  state.q = '';
  renderOrders();
  keepSearchFocus();
}

/** Поиск ничего не нашёл в текущем фильтре — ищем по всем заказам. */
function searchAll() {
  state.filter = 'all';
  renderOrders();
  keepSearchFocus();
}

function orderCardHtml(o) {
  const s = state.meta.statuses.find((x) => x.id === o.status) || { label: o.status, color: '#64748B' };
  // Оплатить можно любой неоплаченный заказ, который не закрыт
  const canPay = o.payment_status !== 'paid' && !['cancelled', 'completed'].includes(o.status);
  const canConfirm = o.status === 'shipped';
  const canCancel = ['new', 'paid'].includes(o.status);
  const accent = s.color;

  return `
    <article class="card card-hover order-card" data-id="${o.id}" style="--k-accent:${accent}">
      <div class="row-between mb-8" style="align-items:flex-start">
        <div>
          <div class="row gap-8 wrap-row">
            <span class="strong mono" style="font-size:15px">${esc(o.order_no)}</span>
            ${badge(o.status, state.meta)}
          </div>
          <div class="xs muted mt-4">${date(o.created_at)} · ${o.items_count} ${plural(o.items_count, 'позиция', 'позиции', 'позиций')}</div>
        </div>
        <div class="right">
          <div class="strong" style="font-size:19px;letter-spacing:-.02em">${money(o.total)}</div>
          <div class="mt-4">${payBadge(o.payment_status, state.meta.paymentStatuses)}</div>
        </div>
      </div>

      ${stepperHtml(o.status)}

      <div class="row wrap-row gap-8 mt-12 xs muted">
        <span>🚚 ${esc(state.meta.deliveryTypes[o.delivery_type] || o.delivery_type)}</span>
        ${o.track_number ? `<span class="mono">📮 ${esc(o.track_number)}</span>` : ''}
        ${o.delivery_cost ? `<span>· доставка ${money(o.delivery_cost)}</span>` : ''}
      </div>

      ${o.comment ? `<div class="notice mt-12"><span class="n-icon">💬</span><span>${esc(o.comment)}</span></div>` : ''}

      ${o.status === 'shipped' && o.confirm_code ? `
        <div class="notice ok mt-12">
          <span class="n-icon">🔑</span>
          <span>Код получения из накладной: <b class="mono">${esc(o.confirm_code)}</b>.
          Подтвердите получение — заказ закроется автоматически.</span>
        </div>` : ''}

      <div class="row wrap-row gap-8 mt-16">
        <button class="btn btn-sm" data-act="open">Подробнее</button>
        ${canPay ? `<button class="btn btn-sm btn-primary" data-act="pay">Оплатить ${money(o.total)}</button>` : ''}
        ${canConfirm ? `<button class="btn btn-sm btn-success" data-act="confirm">Подтвердить получение</button>` : ''}
        ${o.track_number ? `<button class="btn btn-sm" data-act="link">Ссылка на трек</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm btn-ghost" data-act="cancel">Отменить</button>` : ''}
      </div>
    </article>`;
}

function renderOrders() {
  const list = filteredOrders();
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">Мои заказы</h1>
        <div class="small muted">Здравствуйте, ${esc((state.me.name || '').split(' ')[0] || 'клиент')} — вот состояние ваших сборок</div>
      </div>
      <div class="row gap-8">
        <a class="btn" href="/track">Отследить</a>
        <a class="btn btn-primary" href="/builder">+ Собрать новый ПК</a>
      </div>
    </div>

    ${quickBuildHtml()}
    ${summaryHtml()}
    ${toolbarHtml()}

    ${list.length ? `<div class="grid grid-2">${list.map(orderCardHtml).join('')}</div>` : `
      ${state.orders.length
        ? (state.q && state.filter !== 'all'
          ? empty('🔍', 'В этом фильтре ничего нет', `По запросу «${state.q}» совпадений нет среди ${state.filter === 'done' ? 'завершённых' : 'активных'} заказов.`, '<button class="btn btn-primary" onclick="searchAll()">Искать во всех заказах</button>')
          : empty('🔍', 'Ничего не найдено', `По запросу «${state.q}» заказов нет. Проверьте номер или сбросьте поиск.`, '<button class="btn" onclick="clearSearch()">Сбросить поиск</button>'))
        : empty(
          '🖥', 'Заказов пока нет',
          'Соберите ПК в конфигураторе — мы проверим совместимость, посчитаем стоимость сборки и доставки, и оформим заказ.',
          '<a class="btn btn-primary" href="/builder">Открыть конфигуратор</a>'
        )}`}
  `;
  bindOrders();
}

/* Блок «сборка за 1 клик»: сценарии из /api/meta, ссылки ведут в конфигуратор
   с уже подставленным бюджетом. */
function quickBuildHtml() {
  const profiles = (state.meta && state.meta.profiles) || [];
  if (!profiles.length) return '';
  return `
    <section class="quick-cta mb-16">
      <div class="row-between wrap-row gap-12 mb-12">
        <div>
          <h2 style="font-size:var(--t-md);margin:0">Собрать ПК за один клик</h2>
          <div class="small muted">Выберите сценарий — конфигуратор подберёт совместимые детали под бюджет.</div>
        </div>
        <a class="btn btn-sm" href="/builder">Конфигуратор →</a>
      </div>
      <div class="scenario-grid">
        ${profiles.map((p) => `
          <a class="scenario" style="--sc:${p.accent}"
             href="/builder?profile=${encodeURIComponent(p.id)}&budget=${p.budget.default}">
            <div class="sc-icon">${p.icon}</div>
            <div class="sc-title">${esc(p.title)}</div>
            <div class="sc-budget">от ${moneyShort(p.budget.default)}</div>
          </a>`).join('')}
      </div>
    </section>`;
}

function setFilter(f) { state.filter = f; renderOrders(); }
function setSort(s) { state.sort = s; renderOrders(); }
/* Поиск перерисовывает страницу — возвращаем фокус в поле, иначе можно набрать один символ. */
const onSearch = debounce((v) => { state.q = v; renderOrders(); keepSearchFocus(); }, 220);

function bindOrders() {
  document.querySelectorAll('.order-card').forEach((card) => {
    card.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = Number(card.dataset.id);
        const o = state.orders.find((x) => x.id === id);
        const act = b.dataset.act;
        if (act === 'open') openOrder(id);
        if (act === 'pay') payModal(o);
        if (act === 'confirm') confirmModal(o);
        if (act === 'link') copy(trackLink(o.track_number), 'Ссылка скопирована — отправьте её клиенту');
        if (act === 'cancel') cancelOrder(o);
      };
    });
  });
}

/* ============================ Карточка заказа ============================ */
async function openOrder(id) {
  let data;
  try {
    data = await api(`/api/orders/${id}`);
  } catch (e) { return toast(e.message, 'err'); }

  const o = data.order;
  const m = state.meta;
  const msgs = await api(`/api/orders/${id}/messages`).catch(() => []);
  // Кнопка оплаты в подвале карточки: заказ не оплачен и ещё не закрыт.
  const canPay = o.payment_status !== 'paid' && !['cancelled', 'completed'].includes(o.status);

  const items = (data.items || []).map((i) => `
    <div class="item-row">
      <span class="chip ${i.status === 'received' ? 'ok' : i.status === 'reserved' ? 'info' : 'warn'}">${esc(m.itemStatuses[i.status] || i.status)}</span>
      <span class="nm">${esc(i.name)}<span class="xs muted"> · ${esc(i.category)}</span></span>
      <span class="qty">${n2(i.qty)} шт</span>
      <span class="price">${money(n2(i.price) * n2(i.qty))}</span>
    </div>`).join('') || '<div class="small muted">Состав пуст</div>';

  const payments = (data.payments || []).map((p) => `
    <div class="item-row">
      <span class="nm">${esc(m.paymentMethods[p.method] || p.method)}</span>
      <span class="qty">${date(p.created_at)}</span>
      ${payBadge(p.status, m.paymentStatuses)}
      <span class="price">${money(p.amount)}</span>
    </div>`).join('') || '<div class="small muted">Платежей пока нет</div>';

  const track = (data.tracking || []).map((e) => `
    <li class="${e.status === 'delivered' ? 'ok' : ''}">
      <b>${esc(m.shipmentStatuses[e.status] || e.status)}</b>
      <span>${esc([e.location, e.note].filter(Boolean).join(' · '))} · ${date(e.created_at)}</span>
    </li>`).join('');

  const history = (data.history || []).map((h) => `
    <li><b>${esc(h.message)}</b><span>${esc(h.actor === 'client' ? 'вы' : h.actor === 'staff' ? 'мастерская' : 'система')} · ${ago(h.created_at)}</span></li>`).join('');

  const docs = `
    <div class="row wrap-row gap-8">
      <button class="btn btn-sm" onclick="PCB.printDoc(${o.id},'waybill')">📄 Заказ-наряд</button>
      <button class="btn btn-sm" onclick="PCB.printDoc(${o.id},'invoice')">🧾 Счёт</button>
      <button class="btn btn-sm" onclick="PCB.printDoc(${o.id},'act')">🤝 Акт приёма-передачи</button>
      ${o.track_number ? `<button class="btn btn-sm" onclick="PCB.copy(PCB.trackLink('${esc(o.track_number)}'),'Ссылка скопирована')">🔗 Скопировать ссылку</button>` : ''}
    </div>`;

  const wrap = drawer({
    title: `Заказ ${esc(o.order_no)}`,
    subtitle: `${badge(o.status, m)} ${date(o.created_at)}`,
    head: `<div class="right"><div class="strong" style="font-size:20px">${money(o.total)}</div></div>`,
    body: `
      <div class="card">${stepperHtml(o.status)}</div>

      <div class="block">
        <h4>💰 Стоимость</h4>
        <div class="sum-row"><span>Комплектующие</span><b>${money(o.parts_total)}</b></div>
        <div class="sum-row"><span>Сборка и тестирование</span><b>${money(o.assembly_fee)}</b></div>
        <div class="sum-row"><span>Доставка · ${esc(m.deliveryTypes[o.delivery_type] || o.delivery_type)}</span><b>${money(o.delivery_cost)}</b></div>
        <div class="sum-total"><span>Итого</span><b>${money(o.total)}</b></div>
      </div>

      <div class="block"><h4>🧩 Состав сборки</h4>${items}</div>

      <div class="block"><h4>💳 Платежи</h4>${payments}</div>

      <div class="block">
        <h4>🚚 Доставка</h4>
        <div class="small">${esc(m.deliveryTypes[o.delivery_type] || o.delivery_type)}</div>
        <div class="small muted">${esc(o.city || '')} ${esc(o.address || '')}</div>
        ${o.recipient ? `<div class="small muted">Получатель: ${esc(o.recipient)} ${esc(o.recipient_phone || '')}</div>` : ''}
        ${o.track_number ? `
          <div class="row gap-8 mt-8 wrap-row">
            <span class="pill pill-brand">Трек <b class="mono">${esc(o.track_number)}</b></span>
            <button class="btn btn-sm" onclick="PCB.copy(PCB.trackLink('${esc(o.track_number)}'),'Ссылка скопирована')">Копировать ссылку</button>
          </div>` : '<div class="small muted mt-8">Отправление ещё не создано</div>'}
        ${track ? `<ul class="timeline mt-12">${track}</ul>` : ''}
        ${o.status === 'shipped' ? `<div class="notice ok mt-12"><span class="n-icon">🔑</span><span>Код подтверждения: <b class="mono">${esc(o.confirm_code)}</b></span></div>` : ''}
      </div>

      ${o.comment ? `<div class="block"><h4>💬 Пожелания к сборке</h4><div class="small">${esc(o.comment)}</div></div>` : ''}

      ${(data.messages || []).length ? `
      <div class="block">
        <h4>📱 SMS-уведомления</h4>
        <div class="small muted mb-8">Эти сообщения мастерская отправляла вам на телефон</div>
        <div class="list">
          ${data.messages.slice(0, 8).map((msg) => `
            <div class="item-row" style="align-items:flex-start">
              <span class="chip ${msg.status === 'sent' ? 'ok' : msg.status === 'failed' ? 'warn' : ''}">${esc(ago(msg.created_at))}</span>
              <span class="nm sms-text">${esc(msg.text)}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <div class="block">
        <h4>✉️ Сообщения мастерской</h4>
        <div class="chat" id="msg-list">${messagesHtml(msgs)}</div>
        <div class="msg-form">
          <input id="msg-input" placeholder="Написать мастерской…" autocomplete="off">
          <button class="btn btn-primary" id="msg-send">Отправить</button>
        </div>
      </div>

      <div class="block"><h4>🕓 История заказа</h4><ul class="timeline">${history || '<li class="muted"><b>Событий нет</b></li>'}</ul></div>

      <div class="block"><h4>🖨 Документы</h4>${docs}</div>
    `,
    foot: `
      ${canPay ? '<button class="btn btn-primary" id="f-pay">Оплатить заказ</button>' : ''}
      ${o.status === 'shipped' ? '<button class="btn btn-success" id="f-confirm">Подтвердить получение</button>' : ''}
      <button class="btn btn-ghost" onclick="PCB.closeDrawer()">Закрыть</button>
    `,
  });

  /* переписка */
  const input = wrap.querySelector('#msg-input');
  const list = wrap.querySelector('#msg-list');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      const updated = await api(`/api/orders/${id}/messages`, { method: 'POST', body: { message: text } });
      list.innerHTML = messagesHtml(updated);
      input.value = '';
      list.scrollTop = list.scrollHeight;
    } catch (e) { toast(e.message, 'err'); }
  };
  wrap.querySelector('#msg-send').onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  list.scrollTop = list.scrollHeight;

  wrap.querySelector('#f-pay') && (wrap.querySelector('#f-pay').onclick = () => { closeDrawer(); payModal(o); });
  wrap.querySelector('#f-confirm') && (wrap.querySelector('#f-confirm').onclick = () => { closeDrawer(); confirmModal(o); });
}

function messagesHtml(list) {
  return (list || []).map((m) => `
    <div class="msg ${m.author_type === 'client' ? 'me' : 'them'}">
      ${esc(m.message)}
      <span class="msg-time">${m.author_type === 'client' ? 'вы' : 'мастерская'} · ${ago(m.created_at)}</span>
    </div>`).join('') || '<div class="small muted center" style="padding:12px">Сообщений пока нет — напишите мастерской</div>';
}

/* ============================ Оплата ============================ */
const PAY_ICON = { card: '💳', sbp: '⚡', invoice: '🏦', cash: '💵' };

function payModal(o) {
  const m = state.meta;
  const wrap = modal({
    title: `Оплата заказа ${esc(o.order_no)}`,
    body: `
      <div class="card center" style="background:var(--grad-brand-soft)">
        <div class="xs muted strong" style="letter-spacing:.05em">К ОПЛАТЕ</div>
        <div style="font-size:32px;font-weight:800;letter-spacing:-.03em">${money(o.total)}</div>
        <div class="xs muted">${esc(m.deliveryTypes[o.delivery_type] || o.delivery_type)}${o.address ? ' · ' + esc(o.city || '') + ' ' + esc(o.address) : ''}</div>
      </div>
      <h4 style="margin:16px 0 8px;font-size:13px">Способ оплаты</h4>
      <div class="choice-grid">
        ${Object.entries(m.paymentMethods).map(([k, v]) => `
          <label class="choice">
            <input type="radio" name="pay-m" value="${esc(k)}" ${k === 'card' ? 'checked' : ''}>
            <span class="choice-icon">${PAY_ICON[k] || '💰'}</span>
            <span>
              <span class="choice-title">${esc(v)}</span>
              <span class="choice-sub">${k === 'cash' ? 'оплата курьеру при получении' : 'подтверждается сразу'}</span>
            </span>
          </label>`).join('')}
      </div>
      <div class="notice mt-16"><span class="n-icon">ℹ️</span>
        <span>Это демонстрационный платёж: средства списываются в внутреннем учёте, заказ сразу переходит в работу.</span></div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Оплатить', cls: 'btn-primary', icon: '💳',
        onClick: async (w) => {
          const method = (w.querySelector('input[name=pay-m]:checked') || {}).value || 'card';
          try {
            await api(`/api/orders/${o.id}/pay`, { method: 'POST', body: { method } });
            toast(method === 'cash' ? 'Заказ принят: оплата при получении' : 'Оплата прошла успешно', 'ok');
            await loadOrders(); renderOrders(); syncNav();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
  return wrap;
}

/* ============================ Подтверждение получения ============================ */
function confirmModal(o) {
  modal({
    title: 'Подтверждение получения',
    body: `
      <div class="notice warn"><span class="n-icon">⚠️</span>
        <span>Подтверждайте только после проверки комплектации и внешнего вида.
        Код вы найдёте в накладной, в SMS или у курьера.</span></div>
      <div class="field mt-16">
        <label for="cf-code">Код подтверждения — 4 цифры</label>
        <input id="cf-code" class="code-input" inputmode="numeric" maxlength="4" placeholder="_ _ _ _" autocomplete="off">
      </div>
      ${o.payment_status === 'on_delivery' ? `<div class="notice"><span class="n-icon">💵</span><span>К оплате курьеру: <b>${money(o.total)}</b></span></div>` : ''}`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Подтвердить получение', cls: 'btn-success',
        onClick: async (w) => {
          const code = w.querySelector('#cf-code').value.trim();
          if (code.length !== 4) return toast('Введите 4 цифры кода', 'warn');
          try {
            await api(`/api/orders/${o.id}/confirm-receipt`, { method: 'POST', body: { code } });
            toast('Спасибо! Получение подтверждено, заказ закрыт', 'ok');
            await loadOrders(); renderOrders(); syncNav();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
    onOpen: (w) => {
      const input = w.querySelector('#cf-code');
      input.focus();
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 4); });
    },
  });
}

async function cancelOrder(o) {
  const ok = await confirmDialog({
    title: `Отменить заказ ${o.order_no}?`,
    text: 'Заказ будет отменён. Если оплата уже поступила, возврат оформляется по заявлению.',
    okLabel: 'Да, отменить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/orders/${o.id}/cancel`, { method: 'POST', body: { reason: 'Отменён клиентом из кабинета' } });
    toast('Заказ отменён', 'warn');
    await loadOrders(); renderOrders(); syncNav();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ Профиль ============================ */
function renderProfile() {
  const m = state.me;
  const spent = state.orders.filter((o) => o.payment_status === 'paid').reduce((s, o) => s + n2(o.total), 0);
  document.getElementById('app').innerHTML = `
    <div class="mb-16">
      <h1 style="margin:0">Профиль</h1>
      <div class="small muted">Контакты для связи и адрес доставки по умолчанию</div>
    </div>

    <div class="grid grid-sidebar">
      <div class="card">
        <h3 class="mb-12">Мои данные</h3>
        <form id="pf-form" autocomplete="on">
          <div class="form-grid">
            <div class="field full"><label for="pf-name">Имя и фамилия</label>
              <input id="pf-name" value="${esc(m.name || '')}" autocomplete="name" required></div>
            <div class="field"><label for="pf-phone">Телефон</label>
              <input id="pf-phone" type="tel" value="${esc(m.phone || '')}" autocomplete="tel" required></div>
            <div class="field"><label for="pf-email">Email</label>
              <input id="pf-email" type="email" value="${esc(m.email || '')}" autocomplete="email"></div>
            <div class="field"><label for="pf-city">Город</label>
              <input id="pf-city" value="${esc(m.city || '')}" autocomplete="address-level2"></div>
            <div class="field full"><label for="pf-addr">Адрес доставки</label>
              <input id="pf-addr" value="${esc(m.address || '')}" autocomplete="street-address" placeholder="ул. Тверская, 7, кв 15"></div>
          </div>
          <div class="row gap-8 mt-8">
            <button class="btn btn-primary" type="submit" id="pf-save">Сохранить изменения</button>
            <span class="xs muted">Изменения подставятся в новые заказы</span>
          </div>
        </form>

        <hr class="divider" style="margin:20px 0">

        <h3 class="mb-8">Смена пароля</h3>
        <form id="pw-form" autocomplete="on">
          <div class="form-grid">
            <div class="field"><label for="pw-cur">Текущий пароль</label>
              <input id="pw-cur" type="password" autocomplete="current-password"></div>
            <div class="field"><label for="pw-new">Новый пароль</label>
              <input id="pw-new" type="password" autocomplete="new-password" placeholder="минимум 6 символов"></div>
          </div>
          <button class="btn" type="submit" id="pw-save">Обновить пароль</button>
        </form>
      </div>

      <div class="grid" style="gap:14px">
        <div class="grid grid-2" style="gap:12px">
          <div class="stat" style="--stat-accent:var(--brand)">
            <span class="stat-label">Заказов</span>
            <span class="stat-value">${state.orders.length}</span>
          </div>
          <div class="stat" style="--stat-accent:var(--ok)">
            <span class="stat-label">Оплачено</span>
            <span class="stat-value" style="font-size:22px">${moneyShort(spent)} ₽</span>
          </div>
        </div>
        <div class="card">
          <h3 class="mb-8">📱 SMS-уведомления</h3>
          <p class="small muted">
            Присылаем сообщения на этапах: оплата получена, сборка началась, система готова,
            заказ отправлен с трек-номером, курьер везёт, посылка прибыла в пункт выдачи и заказ получен.
          </p>
          <label class="sms-check mt-12">
            <input type="checkbox" id="pf-sms" ${m.sms_opt_in === 0 ? '' : 'checked'}>
            <span>Присылать уведомления на ${esc(m.phone || 'мой телефон')}</span>
          </label>
          <div class="field-hint mt-8">Можно выключить в любой момент — заказы и уведомления в кабинете останутся доступны.</div>
        </div>
        <div class="card">
          <h3 class="mb-12">Как всё устроено</h3>
          <ol class="small muted" style="margin:0;padding-left:18px;line-height:1.9">
            <li>Собираете ПК в конфигураторе</li>
            <li>Оформляете заказ — с доставкой и оплатой</li>
            <li>Оплачаете удобным способом</li>
            <li>Мы закупаем комплектующие и собираем систему</li>
            <li>Тестируем под нагрузкой и упаковываем</li>
            <li>Передаём в доставку — вы получаете трек-номер</li>
            <li>Подтверждаете получение кодом из накладной</li>
          </ol>
        </div>
        <div class="card">
          <h3 class="mb-8">Быстрые ссылки</h3>
          <div class="grid" style="gap:8px">
            <a class="btn btn-block" href="/builder">🛠 Конфигуратор ПК</a>
            <a class="btn btn-block" href="/track">📦 Отследить доставку</a>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('pf-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await withBusy(document.getElementById('pf-save'), () => api('/api/me', {
        method: 'PATCH',
        body: {
          fullName: val('#pf-name'), phone: val('#pf-phone'), email: val('#pf-email'),
          city: val('#pf-city'), address: val('#pf-addr'),
        },
      }));
      toast('Профиль обновлён', 'ok');
      boot();
    } catch (err) { toast(err.message, 'err'); }
  };

  document.getElementById('pw-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await withBusy(document.getElementById('pw-save'), () => api('/api/me', {
        method: 'PATCH',
        body: { currentPassword: val('#pw-cur'), password: val('#pw-new') },
      }));
      toast('Пароль обновлён', 'ok');
      document.getElementById('pw-form').reset();
    } catch (err) { toast(err.message, 'err'); }
  };

  const smsBox = document.getElementById('pf-sms');
  smsBox.onchange = async () => {
    try {
      await api('/api/me', { method: 'PATCH', body: { smsOptIn: smsBox.checked } });
      state.me.sms_opt_in = smsBox.checked ? 1 : 0;
      toast(smsBox.checked ? 'SMS-уведомления включены' : 'SMS-уведомления отключены', 'ok');
    } catch (err) {
      smsBox.checked = !smsBox.checked;
      toast(err.message, 'err');
    }
  };
}

boot().catch((e) => toast(e.message, 'err'));