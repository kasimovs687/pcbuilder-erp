/* ============================================================================
   Панель сборщика: обзор, канбан заказов, приёмка, клиенты, склад, настройки.
   Разделы переключаются через хеш (#/orders, #/stock, …) — ссылку можно дать коллеге.
   ========================================================================== */
const {
  esc, money, moneyShort, num, n2, date, ago, api, toast, modal, closeModal, confirmDialog,
  drawer, closeDrawer, meta, badge, payBadge, plural, debounce, val, empty,
  skeletonCards, skeletonRows, skeletonKanban, hashRouter, withBusy, copy, options,
  printDoc, trackLink,
} = PCB;

const state = {
  me: null, meta: null, health: null,
  orders: [], stats: null, staff: [], supplies: [], clients: [], catalog: [], activity: [],
  settings: null, catalogByCat: {}, sms: null, smsFilter: '',
  view: 'dash',
  q: '', clientQ: '', stockQ: '', stockCat: '', onlyMine: false, filterAll: false,
  clientSort: 'id',
};

let router = null;
const ACTIVE_STATUSES = ['paid', 'purchasing', 'assembling', 'testing', 'ready', 'shipped'];
const WIP_STATUSES = ['paid', 'purchasing', 'assembling', 'testing', 'ready'];

const statusInfo = (id) => state.meta.statuses.find((s) => s.id === id) || { id, label: id, color: '#64748B' };
const kanbanCols = () => (state.filterAll
  ? [...new Set([...state.meta.kanban, 'cancelled'])]
  : state.meta.kanban.filter((s) => !['completed', 'cancelled'].includes(s)));

/** Точка входа для перерисовки текущего раздела. */
function render() {
  const views = {
    dash: renderDash, orders: renderOrders, supplies: renderSupplies,
    clients: renderClients, stock: renderStock, sms: renderSms, settings: renderSettings,
  };
  const fn = views[state.view] || views.dash;
  fn();
  syncNav();
}

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
  } catch (e) { /* не авторизован */ }

  if (!user || user.type !== 'staff') return renderAuth();

  state.me = user;
  document.getElementById('header').style.display = '';
  document.getElementById('who').textContent = state.me.name || 'Сотрудник';
  document.getElementById('avatar').textContent = (state.me.name || 'С').slice(0, 1).toUpperCase();
  document.getElementById('bell-btn').title = `События · ${state.me.name}`;
  PCB.theme.apply();

  await reloadAll();
  await loadActivity();

  router = hashRouter({
    routes: {
      dash: renderDash,
      orders: renderOrders,
      supplies: renderSupplies,
      clients: renderClients,
      stock: renderStock,
      sms: renderSms,
      settings: renderSettings,
    },
    fallback: 'dash',
    onChange: async (view) => {
      state.view = view;
      syncNav();
      // тяжёлые списки подгружаем при первом входе в раздел
      try {
        if (view === 'supplies' && !state.supplies.length) await loadSupplies();
        if (view === 'clients' && !state.clients.length) await loadClients();
        if (view === 'stock' && !state.catalog.length) await loadCatalog();
        if (view === 'sms') await loadSms();
        if (view === 'settings') await loadSettings();
      } catch (e) { toast(e.message, 'err'); }
      render();
    },
  });
  router.refresh();
}

async function reloadAll() {
  const [orders, stats, staff] = await Promise.all([
    api('/api/orders'), api('/api/stats'), api('/api/staff'),
  ]);
  state.orders = orders;
  state.stats = stats;
  state.staff = staff;
}

async function loadSupplies() { state.supplies = await api('/api/supplies'); }
async function loadClients() {
  state.clients = await api('/api/clients' + (state.clientQ ? '?q=' + encodeURIComponent(state.clientQ) : ''));
}
async function loadCatalog() {
  state.catalog = await api('/api/components');
  state.catalogByCat = {};
  for (const c of state.catalog) (state.catalogByCat[c.category] ||= []).push(c);
}
async function loadActivity() {
  state.activity = await api('/api/activity?limit=14').catch(() => []);
  const dot = document.getElementById('bell-dot');
  const n = state.activity.length;
  dot.textContent = n > 9 ? '9+' : String(n);
  dot.classList.toggle('hidden', !n);
}
async function loadSettings() {
  const [s, h] = await Promise.all([api('/api/settings'), api('/api/health')]);
  state.settings = s;
  state.health = h;
}

function syncNav() {
  document.querySelectorAll('#nav [data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  const btn = document.querySelector('#nav [data-view="orders"]');
  if (btn) {
    const n = state.orders.filter((o) => WIP_STATUSES.includes(o.status)).length;
    btn.innerHTML = `Заказы${n ? ` <span class="nav-count">${n}</span>` : ''}`;
  }
  const sp = document.querySelector('#nav [data-view="supplies"]');
  if (sp && state.stats) {
    const n = state.stats.suppliesInTransit;
    sp.innerHTML = `Приёмка${n ? ` <span class="nav-count">${n}</span>` : ''}`;
  }
}

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
          <div class="auth-sub">Панель сборщика: заказы, склад, приёмка, логистика</div>
        </div>
        <div class="card">
          <form id="st-form">
            <div class="field"><label for="st-login">Логин</label>
              <input id="st-login" autocomplete="username" placeholder="Логин"></div>
            <div class="field"><label for="st-pass">Пароль</label>
              <input id="st-pass" type="password" autocomplete="current-password" placeholder="••••••"></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Войти</button>
          </form>
        </div>
        <div class="notice mt-16"><span class="n-icon">💡</span>
          <span>Доступ выдаёт администратор. Забыли пароль — он указан в файле
          <b class="mono">secrets.local.json</b> на сервере.</span></div>
        <div class="row gap-8 mt-16" style="justify-content:center">
          <a class="btn btn-sm btn-ghost" href="/">← На главную</a>
          <a class="btn btn-sm btn-ghost" href="/client">Кабинет клиента</a>
        </div>
      </div>
    </div>`;

  document.getElementById('st-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    try {
      await withBusy(btn, () => api('/api/auth/login', {
        method: 'POST',
        body: { login: val('#st-login'), password: val('#st-pass'), role: 'staff' },
      }));
      toast('Добро пожаловать!', 'ok');
      boot();
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ============================ Обзор ============================ */
function kpiHtml() {
  const s = state.stats || {};
  const series = s.series || [];
  const maxOrders = Math.max(1, ...series.map((d) => d.orders));
  const last7 = series.slice(-7);
  const spark = last7.map((d) => `<i class="${d.orders ? '' : 'zero'}" style="height:${Math.max(8, (d.orders / maxOrders) * 100)}%" title="${d.day}: ${d.orders} ${plural(d.orders, 'заказ', 'заказа', 'заказов')}"></i>`).join('');

  return `
    <div class="grid grid-4 mb-16">
      <div class="stat" style="--stat-accent:var(--ok)">
        <div class="stat-icon">💰</div>
        <span class="stat-label">Поступило оплат</span>
        <span class="stat-value">${moneyShort(s.revenue)} <span class="unit">₽</span></span>
        <span class="stat-foot">за всё время</span>
        ${spark ? `<div class="spark" title="Заказы за 7 дней">${spark}</div>` : ''}
      </div>
      <div class="stat" style="--stat-accent:var(--brand)">
        <div class="stat-icon">🛠</div>
        <span class="stat-label">В работе</span>
        <span class="stat-value">${s.inWork || 0}</span>
        <span class="stat-foot">${s.today ? `+${s.today} сегодня` : 'новых сегодня нет'}</span>
      </div>
      <div class="stat" style="--stat-accent:var(--warn)">
        <div class="stat-icon">⏳</div>
        <span class="stat-label">Ждут оплаты</span>
        <span class="stat-value">${s.unpaid || 0}</span>
        <span class="stat-foot">${s.avgOrder ? `средний чек ${moneyShort(s.avgOrder)} ₽` : '—'}</span>
      </div>
      <div class="stat" style="--stat-accent:var(--info)">
        <div class="stat-icon">👥</div>
        <span class="stat-label">Клиентов</span>
        <span class="stat-value">${s.clients || 0}</span>
        <span class="stat-foot">${s.clientsNew ? `+${s.clientsNew} за 30 дней` : 'база клиентов'}</span>
      </div>
    </div>`;
}

function statusBarsHtml() {
  const counts = (state.stats && state.stats.counts) || {};
  const total = Object.values(counts).reduce((s, v) => s + n2(v), 0) || 1;
  return state.meta.statuses.map((s) => {
    const n = n2(counts[s.id]);
    const pct = Math.round((n / total) * 100);
    return `
      <div class="row gap-8" style="margin-bottom:9px">
        <span style="width:120px;font-size:12px;font-weight:600;color:var(--muted)" class="nowrap">${esc(s.label)}</span>
        <span class="bar-mini grow"><i style="width:${pct}%;background:${s.color}"></i></span>
        <b style="width:34px;text-align:right;font-size:12px">${n}</b>
      </div>`;
  }).join('');
}

function activityHtml() {
  if (!state.activity.length) return '<div class="small muted">Событий пока нет</div>';
  const icon = { status: '🔄', payment: '💳', created: '📋', stock: '📦', logistics: '🚚', receipt: '🤝', message: '✉️', assign: '👷' };
  return `<ul class="timeline">${state.activity.map((a) => `
    <li class="${a.kind === 'payment' || a.kind === 'receipt' ? 'ok' : a.kind === 'stock' ? 'warn' : ''}">
      <b>${esc(icon[a.kind] || '•')} ${esc(a.message || '')}</b>
      <span>${a.order_no ? esc(a.order_no) + ' · ' : ''}${ago(a.created_at)}</span>
    </li>`).join('')}</ul>`;
}

function renderDash() {
  const s = state.stats || {};
  const series = (s.series || []).slice(-14);
  const max = Math.max(1, ...series.map((d) => d.orders));
  const chart = series.map((d) => `
    <div class="col" title="${d.day}: ${d.orders} заказ(ов), ${money(d.revenue)}">
      <div class="col-bar" style="height:${d.orders ? Math.max(6, (d.orders / max) * 100) : 2}%"></div>
      <span class="col-label">${esc(d.day.slice(8))}.${esc(d.day.slice(5, 7))}</span>
    </div>`).join('');

  const staffRows = (s.byAssembler || []).map((a) => `
    <tr>
      <td class="cell-main">${esc(a.full_name)}</td>
      <td class="num">${n2(a.total)}</td>
      <td class="num">${n2(a.wip) ? `<span class="chip warn">${n2(a.wip)}</span>` : '—'}</td>
      <td class="num">${n2(a.done) ? `<span class="chip ok">${n2(a.done)}</span>` : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="small muted">Нет данных</td></tr>';

  const low = (s.lowStock || []).map((c) => `
    <div class="item-row">
      <span class="nm">${esc(c.name)}</span>
      <span class="chip ${n2(c.stock) === 0 ? 'err' : 'warn'}">${n2(c.stock)} шт</span>
    </div>`).join('') || '<div class="small muted">Всё в наличии</div>';

  document.getElementById('app').innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">Обзор</h1>
        <div class="small muted">${date(new Date().toISOString().slice(0, 10))} · ${esc(state.me.name)}</div>
      </div>
      <div class="row gap-8">
        <button class="btn" onclick="reloadAll().then(()=>{renderDash();toast('Данные обновлены','ok')})">🔄 Обновить</button>
        <button class="btn btn-primary" onclick="newOrder()">+ Новый заказ</button>
      </div>
    </div>

    ${kpiHtml()}

    <div class="grid grid-sidebar">
      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="card-head" style="padding:0 0 12px;border:0">
            <h3>Заказы за 14 дней</h3>
            <span class="small muted">по ${money((s.series || []).reduce((a, d) => a + n2(d.revenue), 0))}</span>
          </div>
          <div class="chart">${chart}</div>
        </div>

        <div class="card">
          <div class="card-head" style="padding:0 0 12px;border:0">
            <h3>Загрузка сборщиков</h3>
            <span class="small muted">всего / в работе / завершено</span>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Сотрудник</th><th class="num">Заказов</th><th class="num">В работе</th><th class="num">Готово</th></tr></thead>
              <tbody>${staffRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="grid" style="gap:14px">
        <div class="card">
          <h3 class="mb-12">Заказы по статусам</h3>
          ${statusBarsHtml()}
        </div>
        <div class="card">
          <h3 class="mb-12">События</h3>
          ${activityHtml()}
          <button class="btn btn-sm btn-block mt-12" onclick="loadActivity().then(()=>{document.getElementById('activity-inline').innerHTML=activityHtml()})">Обновить ленту</button>
        </div>
        <div class="card">
          <div class="row-between mb-12">
            <h3 style="margin:0">Заканчивается</h3>
            <span class="chip ${n2(s.lowStockCount) ? 'warn' : 'ok'}">${s.lowStockCount || 0}</span>
          </div>
          ${low}
          <button class="btn btn-sm btn-block mt-12" onclick="location.hash='#/stock'">Перейти на склад</button>
        </div>
      </div>
    </div>`;
}

/* колокольчик: выпадающая лента событий */
function toggleActivity(e) {
  e.stopPropagation();
  const box = document.getElementById('activity-menu');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="menu" style="right:0;min-width:320px;max-height:60vh;overflow:auto">
      <div class="menu-head">
        <div class="strong">Последние события</div>
        <div class="xs muted">по всем заказам</div>
      </div>
      <div id="activity-inline">${activityHtml()}</div>
      <button class="menu-item" onclick="location.hash='#/dash'">Открыть обзор</button>
    </div>`;
}

/* ============================ Заказы: канбан ============================ */
function visibleOrders() {
  const q = state.q.toLowerCase().trim();
  return state.orders.filter((o) => {
    if (state.onlyMine && o.assembler_id !== state.me.id) return false;
    if (!q) return true;
    return `${o.order_no} ${o.client_name || ''} ${o.client_phone || ''} ${o.assembler_name || ''}`
      .toLowerCase().includes(q);
  });
}

function kanbanHtml() {
  const list = visibleOrders();
  return kanbanCols().map((st) => {
    const s = statusInfo(st);
    const items = list.filter((o) => o.status === st);
    const sum = items.reduce((acc, o) => acc + n2(o.total), 0);

    const cards = items.map((o) => {
      const done = n2(o.items_received);
      const total = n2(o.items_count);
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `
        <article class="kcard ${o.client_unread ? 'has-unread' : ''}" draggable="true" data-id="${o.id}" data-status="${o.status}" style="--k-accent:${s.color}">
          <div class="kcard-top">
            <span class="kcard-no">${esc(o.order_no)}</span>
            ${o.client_unread ? `<span class="unread-dot" title="Клиент ждёт ответа">💬 ${n2(o.client_unread)}</span>` : ''}
            <span class="kcard-when">${date(o.created_at).slice(0, 5)}</span>
          </div>
          <div class="kcard-client">${esc(o.client_name || '—')}${o.client_phone ? ` · <span class="muted">${esc(o.client_phone)}</span>` : ''}</div>
          <div class="bar-mini ${pct >= 100 ? 'done' : ''}"><i style="width:${pct}%"></i></div>
          <div class="kcard-foot">
            <span class="kcard-sum">${money(o.total)}</span>
            <span class="xs muted nowrap">${done}/${total} поз.</span>
          </div>
          <div class="kcard-meta">
            ${payBadge(o.payment_status, state.meta.paymentStatuses)}
            ${o.assembler_name ? `<span class="pill">👷 ${esc(o.assembler_name)}</span>` : ''}
          </div>
        </article>`;
    }).join('') || `<div class="xs muted center" style="padding:14px 6px">Перетащите заказ сюда</div>`;

    return `
      <section class="kcol" data-status="${st}">
        <div class="kcol-head">
          <span class="kdot" style="color:${s.color};background:${s.color}"></span>
          <span class="kname">${esc(s.label)}</span>
          <span class="kcount">${items.length}</span>
        </div>
        <div class="klist">${cards}</div>
        ${sum ? `<div class="kcol-head" style="position:static;padding-top:2px">
          <span class="ksum">Σ ${moneyShort(sum)} ₽</span></div>` : ''}
      </section>`;
  }).join('');
}

function renderOrders() {
  const s = state.stats || {};
  const counts = s.counts || {};
  document.getElementById('app').innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">Заказы</h1>
        <div class="small muted">${counts.paid || 0} ждут запуска · ${s.inWork || 0} в работе · перетаскивайте карточки между колонками</div>
      </div>
      <div class="row gap-8">
        <button class="btn" onclick="goSupplies()">📥 Приёмка${s.suppliesInTransit ? ` (${s.suppliesInTransit})` : ''}</button>
        <button class="btn btn-primary" onclick="newOrder()">+ Новый заказ</button>
      </div>
    </div>

    <div class="card mb-16">
      <div class="row wrap-row gap-12">
        <div class="input-icon grow" style="min-width:240px">
          <span class="i">🔍</span>
          <input data-search-input placeholder="Номер заказа, клиент, телефон, сборщик"
                 value="${esc(state.q)}" oninput="onOrderSearch(this.value)">
        </div>
        <label class="row gap-8 small" style="cursor:pointer;user-select:none">
          <input type="checkbox" ${state.onlyMine ? 'checked' : ''} onchange="toggleMine(this.checked)">
          Только мои заказы
        </label>
        <div class="seg">
          <button class="${state.filterAll ? 'active' : ''}" onclick="setOrdersScope(true)">Все</button>
          <button class="${state.filterAll ? '' : 'active'}" onclick="setOrdersScope(false)">Активные</button>
        </div>
      </div>
    </div>

    <div class="kanban">${kanbanHtml()}</div>`;

  bindKanban();
}

const onOrderSearch = debounce((v) => { state.q = v; renderOrders(); PCB.keepSearchFocus(); }, 220);
function toggleMine(v) { state.onlyMine = v; renderOrders(); }
function setOrdersScope(all) { state.filterAll = all; renderOrders(); }
function goSupplies() { location.hash = '#/supplies'; }

function bindKanban() {
  let dragId = null;

  document.querySelectorAll('.kcard').forEach((card) => {
    card.addEventListener('click', () => openOrder(Number(card.dataset.id)));
    card.addEventListener('dragstart', (e) => {
      dragId = Number(card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragId));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.kcol').forEach((c) => c.classList.remove('drop-ok', 'drop-no'));
    });
  });

  document.querySelectorAll('.kcol').forEach((col) => {
    const target = col.dataset.status;
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      const order = state.orders.find((o) => o.id === dragId);
      const allowed = !order || order.status === target ||
        (state.meta.flow[order.status] || []).includes(target) || target === 'cancelled';
      col.classList.toggle('drop-ok', allowed);
      col.classList.toggle('drop-no', !allowed);
      e.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop-ok', 'drop-no'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-ok', 'drop-no');
      const id = Number(e.dataTransfer.getData('text/plain')) || dragId;
      dragId = null;
      const order = state.orders.find((o) => o.id === id);
      if (!order || order.status === target) return;
      await changeStatus(id, target);
    });
  });
}

async function changeStatus(id, target, note = '') {
  const order = state.orders.find((o) => o.id === id);
  const to = statusInfo(target);
  try {
    await api(`/api/orders/${id}/status`, {
      method: 'PATCH',
      body: { status: target, note, force: target === 'cancelled' },
    });
    toast(`${order ? order.order_no : 'Заказ'} → «${to.label}»`, 'ok');
    await reloadAll();
    syncNav();
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ Карточка заказа (drawer) ============================ */
function sumBlockHtml(o) {
  return `
    <div class="sum-row"><span>Комплектующие</span><b>${money(o.parts_total)}</b></div>
    <div class="sum-row"><span>Сборка и тестирование</span><b>${money(o.assembly_fee)}</b></div>
    <div class="sum-row"><span>Доставка</span><b>${money(o.delivery_cost)}</b></div>
    <div class="sum-total"><span>Итого</span><b>${money(o.total)}</b></div>`;
}

async function openOrder(id) {
  let data;
  try {
    data = await api(`/api/orders/${id}`);
  } catch (e) { return toast(e.message, 'err'); }

  const o = data.order;
  const m = state.meta;
  const msgs = await api(`/api/orders/${id}/messages`).catch(() => []);
  // Клиент написал после нашего последнего ответа — открываем сразу переписку.
  const clientUnread = (state.orders.find((x) => x.id === o.id) || {}).client_unread
    || msgs.filter((x) => x.author_type === 'client'
      && (!msgs.some((y) => y.author_type === 'staff' && y.created_at > x.created_at))).length;

  const flow = (m.flow[o.status] || []).filter((x) => x !== 'cancelled');
  const statusBtns = flow.map((st) => {
    const t = statusInfo(st);
    return `<button class="btn btn-sm" data-next="${st}" style="border-color:${t.color}59;color:${t.color}">→ ${esc(t.label)}</button>`;
  }).join('');

  const items = (data.items || []).map((i) => {
    const cls = i.status === 'received' ? 'ok' : i.status === 'reserved' ? 'info' : 'warn';
    return `
      <div class="item-row">
        <span class="chip ${cls}">${esc(m.itemStatuses[i.status] || i.status)}</span>
        <span class="nm">${esc(i.name)}<span class="xs muted"> · ${esc(i.category)} · ${n2(i.qty)} шт</span></span>
        <b class="price">${money(n2(i.price) * n2(i.qty))}</b>
        ${i.status !== 'received'
          ? `<button class="btn btn-sm btn-success" data-item="${i.id}">Принять</button>`
          : '<span class="chip ok">✓</span>'}
      </div>`;
  }).join('') || '<div class="small muted">Позиций нет</div>';

  const payments = (data.payments || []).map((p) => `
    <div class="item-row">
      <span class="nm">${esc(m.paymentMethods[p.method] || p.method)}</span>
      <span class="qty">${date(p.created_at)}</span>
      ${payBadge(p.status, m.paymentStatuses)}
      <b class="price">${money(p.amount)}</b>
    </div>`).join('') || '<div class="small muted">Платежей нет</div>';

  const track = (data.tracking || []).map((e) => `
    <li class="${e.status === 'delivered' ? 'ok' : ''}">
      <b>${esc(m.shipmentStatuses[e.status] || e.status)}</b>
      <span>${esc([e.location, e.note].filter(Boolean).join(' · '))} · ${date(e.created_at)}</span>
    </li>`).join('');

  const history = (data.history || []).map((h) => `
    <li><b>${esc(h.message)}</b><span>${esc(h.actor)} · ${ago(h.created_at)}</span></li>`).join('')
    || '<li class="muted"><b>Событий нет</b></li>';

  const staffOpts = state.staff.map((s) => `
    <option value="${s.id}" ${o.assembler_id === s.id ? 'selected' : ''}>${esc(s.full_name)} · ${esc(s.role === 'admin' ? 'админ' : 'сборщик')}</option>`).join('');

  const wrap = drawer({
    wide: true,
    title: `${esc(o.order_no)} ${badge(o.status, m)}`,
    subtitle: `${esc(o.client_name || '—')} · ${esc(o.client_phone || '')} · ${date(o.created_at)}`,
    head: `<div class="right"><div class="strong" style="font-size:20px">${money(o.total)}</div>
           <div>${payBadge(o.payment_status, m.paymentStatuses)}</div></div>`,
    body: `
      <div class="row wrap-row gap-8" data-tab-bar>
        <button class="seg active" data-tab="items">🧩 Состав</button>
        <button class="seg" data-tab="money">💰 Оплата</button>
        <button class="seg" data-tab="logi">🚚 Логистика</button>
        <button class="seg ${clientUnread ? 'seg-unread' : ''}" data-tab="chat">✉️ Переписка${clientUnread ? ` <span class="nav-count">${n2(clientUnread)}</span>` : ''}</button>
        <button class="seg" data-tab="hist">🕓 История</button>
      </div>

      <div data-panel="items">
        <div class="block">
          <h4>Статус заказа</h4>
          <div class="row wrap-row gap-6">
            ${statusBtns}
            ${['cancelled', 'completed'].includes(o.status)
              ? '' : '<button class="btn btn-sm btn-danger" data-act="cancel">Отменить заказ</button>'}
          </div>
          ${o.comment ? `<div class="notice mt-12"><span class="n-icon">💬</span><span>${esc(o.comment)}</span></div>` : ''}
        </div>

        <div class="block">
          <div class="row-between">
            <h4 style="margin:0">SMS-уведомления</h4>
            <button class="btn btn-sm" data-act="sms">📱 Написать клиенту</button>
          </div>
          ${(data.messages || []).length ? `
            <div class="list mt-8" style="max-height:190px;overflow:auto">
              ${data.messages.slice(0, 6).map((msg) => `
                <div class="item-row" style="align-items:flex-start">
                  <span class="chip ${(SMS_STATUS[msg.status] || {}).cls || ''}">${esc((SMS_STATUS[msg.status] || {}).label || msg.status)}</span>
                  <span class="nm sms-text"><div>${esc(msg.text)}</div>
                    <div class="sms-sub">${esc(EVENT_TITLE[msg.event] || msg.event)} · ${ago(msg.created_at)}</div></span>
                </div>`).join('')}
            </div>` : `<div class="small muted mt-8">Уведомлений пока нет. Они отправляются автоматически при смене этапа, если в разделе SMS включён канал.</div>`}
        </div>

        <div class="block">
          <h4>Клиент и доставка</h4>
          <div class="grid grid-2 gap-8">
            <div>
              <div class="strong">${esc(o.client_name || '')}</div>
              <div class="small muted">${esc((data.client && data.client.email) || '')}</div>
              <div class="small">📞 ${esc(o.client_phone || (data.client && data.client.phone) || '')}</div>
            </div>
            <div>
              <div class="small muted">Способ получения</div>
              <div class="small">${esc(m.deliveryTypes[o.delivery_type] || o.delivery_type)}</div>
              <div class="small muted">${esc(o.city || '')} ${esc(o.address || '')}</div>
              ${o.recipient ? `<div class="small muted">Получатель: ${esc(o.recipient)} ${esc(o.recipient_phone || '')}</div>` : ''}
            </div>
          </div>
        </div>

        <div class="block">
          <h4>Комплектующие · приёмка на склад</h4>
          ${items}
          <div class="xs muted mt-8">Принятые позиции пополняют склад и снимают резерв.</div>
        </div>

        <div class="block">
          <h4>Назначенный сборщик</h4>
          <div class="row gap-8 wrap-row">
            <select id="dr-assign" style="max-width:280px">
              <option value="">— не назначен —</option>${staffOpts}
            </select>
            <button class="btn btn-sm" data-act="assign">Назначить</button>
          </div>
        </div>
      </div>

      <div data-panel="money" hidden>
        <div class="block"><h4>Расчёт</h4>${sumBlockHtml(o)}</div>
        <div class="block">
          <h4>Платежи</h4>
          ${payments}
          <div class="row wrap-row gap-8 mt-12">
            ${o.payment_status !== 'paid' ? '<button class="btn btn-sm btn-success" data-act="payconfirm">✓ Подтвердить оплату</button>' : ''}
            <button class="btn btn-sm" onclick="PCB.printDoc(${o.id},'invoice')">🧾 Печать счёта</button>
          </div>
        </div>
        <div class="block"><h4>Документы</h4>
          <div class="row wrap-row gap-8">
            <button class="btn btn-sm" onclick="PCB.printDoc(${o.id},'waybill')">📄 Заказ-наряд</button>
            <button class="btn btn-sm" onclick="PCB.printDoc(${o.id},'act')">🤝 Акт</button>
          </div>
        </div>
      </div>

      <div data-panel="logi" hidden>
        <div class="block">
          <h4>Отправление</h4>
          ${o.track_number ? `
            <div class="row gap-8 wrap-row">
              <span class="pill pill-brand">Трек <b class="mono">${esc(o.track_number)}</b></span>
              <span class="pill">🔑 ${esc(o.confirm_code || '—')}</span>
            </div>
            <div class="row wrap-row gap-8 mt-12">
              <button class="btn btn-sm" data-act="track">+ Событие доставки</button>
              <button class="btn btn-sm" onclick="PCB.copy(PCB.trackLink('${esc(o.track_number)}'),'Ссылка скопирована')">🔗 Скопировать ссылку для клиента</button>
              <button class="btn btn-sm btn-ghost" onclick="window.open('/track/${esc(o.track_number)}','_blank')">Открыть /track</button>
            </div>
            ${o.status === 'shipped' ? '<div class="row mt-12"><button class="btn btn-sm btn-success" data-act="staffconfirm">✓ Подтвердить получение (по звонку)</button></div>' : ''}
          ` : '<div class="small muted">Отправление не создано</div>'}
          ${!o.track_number ? '<div class="mt-12"><button class="btn btn-sm btn-primary" data-act="ship">🚚 Оформить отправку</button></div>' : ''}
        </div>
        <div class="block"><h4>История перемещения</h4>
          ${track ? `<ul class="timeline">${track}</ul>` : '<div class="small muted">Событий нет</div>'}
        </div>
      </div>

      <div data-panel="chat" hidden>
        <div class="block">
          <h4>Переписка с клиентом</h4>
          <div class="chat" id="msg-list">${messagesHtml(msgs)}</div>
          <div class="msg-form">
            <input id="msg-input" placeholder="Написать клиенту…" autocomplete="off">
            <button class="btn btn-primary" id="msg-send">Отправить</button>
          </div>
        </div>
      </div>

      <div data-panel="hist" hidden>
        <div class="block"><h4>История заказа</h4><ul class="timeline">${history}</ul></div>
      </div>
    `,
    foot: `
      ${flow.length ? `<button class="btn btn-primary" data-next="${flow[0]}">→ ${esc(statusInfo(flow[0]).label)}</button>` : ''}
      ${o.status === 'shipped' ? '<button class="btn btn-success" data-act="staffconfirm">✓ Получен</button>' : ''}
      <button class="btn btn-ghost" onclick="PCB.closeDrawer()">Закрыть</button>`,
  });

  /* вкладки */
  const startTab = clientUnread ? 'chat' : 'items';
  wrap.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === startTab);
    b.onclick = () => {
      wrap.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      wrap.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
      if (b.dataset.tab === 'chat') {
        const tab = state.orders.find((x) => x.id === o.id);
        if (tab) tab.client_unread = 0;
      }
    };
  });
  wrap.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== startTab; });
  // Ответили клиенту — счётчик на карточке гаснет.
  const card = document.querySelector(`.kcard[data-id="${o.id}"]`);
  if (card) {
    const badge = card.querySelector('.unread-dot');
    if (badge) badge.remove();
    card.classList.remove('has-unread');
  }

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

  /* переходы статуса */
  wrap.querySelectorAll('[data-next]').forEach((b) => {
    b.onclick = async (e) => {
      await withBusy(e.currentTarget, () => changeStatus(id, b.dataset.next));
      closeDrawer();
    };
  });

  /* приёмка позиций */
  wrap.querySelectorAll('[data-item]').forEach((b) => {
    b.onclick = async (e) => {
      try {
        await withBusy(e.currentTarget, () => api(`/api/order-items/${b.dataset.item}/receive`, { method: 'POST', body: {} }));
        toast('Компонент принят на склад', 'ok');
        closeDrawer();
        await reloadAll();
        render();
        openOrder(id);
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  /* прочие действия */
  wrap.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      try {
        if (act === 'payconfirm') {
          await api(`/api/orders/${id}/payment/confirm`, { method: 'POST', body: { ok: true } });
          toast('Оплата подтверждена', 'ok');
          closeDrawer(); await reloadAll(); render(); openOrder(id);
        }
        if (act === 'assign') {
          const v = wrap.querySelector('#dr-assign').value;
          await api(`/api/orders/${id}/assign`, { method: 'POST', body: { assemblerId: v ? Number(v) : null } });
          toast(v ? 'Сборщик назначен' : 'Сборщик снят с заказа', 'ok');
          closeDrawer(); await reloadAll(); render();
        }
        if (act === 'cancel') {
          closeDrawer();
          const ok = await confirmDialog({
            title: `Отменить ${o.order_no}?`,
            text: 'Позиции вернутся в свободный остаток, клиент увидит статус «Отменён».',
            okLabel: 'Отменить заказ', danger: true,
          });
          if (ok) { await changeStatus(id, 'cancelled', 'Отменён сборщиком'); openOrder(id); }
        }
        if (act === 'staffconfirm') {
          await api(`/api/orders/${id}/receipt-confirm-by-staff`, { method: 'POST', body: {} });
          toast('Получение подтверждено', 'ok');
          closeDrawer(); await reloadAll(); render(); openOrder(id);
        }
        if (act === 'ship') { closeDrawer(); shipModal(o); }
        if (act === 'track') { closeDrawer(); trackModal(o); }
        if (act === 'sms') { smsModal(id); }
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  wrap.querySelectorAll('.drawer-foot [data-next]').forEach((b) => {
    b.onclick = async (e) => {
      await withBusy(e.currentTarget, () => changeStatus(id, b.dataset.next));
      closeDrawer();
    };
  });
}

function messagesHtml(list) {
  return (list || []).map((m) => `
    <div class="msg ${m.author_type === 'staff' ? 'me' : 'them'}">
      ${esc(m.message)}
      <span class="msg-time">${m.author_type === 'staff' ? 'вы' : 'клиент'} · ${ago(m.created_at)}</span>
    </div>`).join('') || '<div class="small muted center" style="padding:12px">Сообщений пока нет</div>';
}

/* ============================ Приёмка ============================ */
function suppliesListHtml() {
  if (!state.supplies.length) {
    return empty('📥', 'Поставок пока нет',
      'Оформите поставку комплектующих от поставщика — после приёмки они попадут на склад.',
      '<button class="btn btn-primary" onclick="newSupply()">+ Новая поставка</button>');
  }
  return state.supplies.map((s) => {
    const received = s.status === 'received';
    return `
      <div class="card mb-12">
        <div class="row-between wrap-row gap-12 mb-12">
          <div class="row gap-12">
            <div class="preview-ic" style="font-size:17px">${received ? '✅' : '🚚'}</div>
            <div>
              <div class="row gap-8 wrap-row">
                <span class="strong">Поставка №${s.id}</span>
                <span class="chip ${received ? 'ok' : 'warn'}">${received ? 'Принята' : 'В пути'}</span>
              </div>
              <div class="small muted">${esc(s.supplier)}${s.invoice_no ? ` · накладная ${esc(s.invoice_no)}` : ''} · ${date(s.created_at)}</div>
            </div>
          </div>
          <div class="row gap-8">
            <div class="right">
              <div class="strong">${money(s.total)}</div>
              <div class="xs muted">${s.items.length} ${plural(s.items.length, 'позиция', 'позиции', 'позиций')}</div>
            </div>
            ${received ? '' : `<button class="btn btn-sm btn-success" data-receive="${s.id}">Принять на склад</button>`}
          </div>
        </div>
        <div class="block" style="background:var(--surface-2)">
          ${s.items.map((i) => `
            <div class="item-row">
              <span class="nm">${esc(i.name)}</span>
              <span class="qty">${n2(i.qty)} шт</span>
              <b class="price">${money(i.purchase_price)}</b>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderSupplies() {
  document.getElementById('app').innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">Приёмка комплектующих</h1>
        <div class="small muted">Поставки от поставщиков → склад → комплект укомплектован → заказ уходит в сборку</div>
      </div>
      <button class="btn btn-primary" onclick="newSupply()">+ Новая поставка</button>
    </div>
    <div class="notice mb-16"><span class="n-icon">ℹ️</span>
      <span>После приёмки остатки склада пополняются автоматически. Если поставка привязана к заказу и закрывает все его позиции — заказ сам перейдёт в «Сборку».</span></div>
    <div id="supplies-box">${suppliesListHtml()}</div>`;
  bindSupplies();
}

function bindSupplies() {
  document.querySelectorAll('[data-receive]').forEach((b) => {
    b.onclick = async () => {
      try {
        await withBusy(b, () => api(`/api/supplies/${b.dataset.receive}/receive`, { method: 'POST', body: {} }));
        toast('Поставка принята, склад пополнен', 'ok');
        await loadSupplies();
        await reloadAll();
        render();
        loadActivity();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function newSupply() {
  if (!state.catalog.length) {
    try { await loadCatalog(); } catch (e) { return toast(e.message, 'err'); }
  }
  const catOpts = Object.entries(state.catalogByCat).map(([cat, items]) => `
    <optgroup label="${esc(cat)}">
      ${items.map((c) => `<option value="${c.id}" data-price="${n2(c.price)}">${esc(c.name)} — ${money(c.price)}</option>`).join('')}
    </optgroup>`).join('');

  const orderOpts = state.orders
    .filter((o) => ['paid', 'purchasing', 'assembling'].includes(o.status))
    .map((o) => `<option value="${o.id}">${esc(o.order_no)} · ${esc(o.client_name || '')}</option>`).join('');

  modal({
    wide: true,
    title: 'Новая поставка',
    body: `
      <div class="form-grid">
        <div class="field"><label for="sp-sup">Поставщик</label>
          <input id="sp-sup" value="ООО «Компьютерный мир»"></div>
        <div class="field"><label for="sp-inv">Номер накладной</label>
          <input id="sp-inv" placeholder="INV-2026-001"></div>
        <div class="field full"><label for="sp-order">Заказ (необязательно)</label>
          <select id="sp-order"><option value="">— без привязки —</option>${orderOpts}</select></div>
      </div>
      <h4 style="margin:8px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Позиции поставки</h4>
      <div id="sp-items"></div>
      <button class="btn btn-sm mt-8" onclick="addSupplyRow()">+ добавить позицию</button>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Создать поставку', cls: 'btn-primary', onClick: async () => {
          const items = [...document.querySelectorAll('.sp-row')].map((r) => ({
            componentId: Number(r.querySelector('.sp-c').value),
            qty: Number(r.querySelector('.sp-q').value || 1),
            purchasePrice: Number(r.querySelector('.sp-p').value || 0),
          })).filter((i) => i.componentId);
          if (!items.length) return toast('Добавьте хотя бы одну позицию', 'err');
          try {
            await api('/api/supplies', {
              method: 'POST',
              body: {
                supplier: val('#sp-sup'), invoiceNo: val('#sp-inv'),
                orderId: val('#sp-order') ? Number(val('#sp-order')) : null, items,
              },
            });
            toast('Поставка создана — можно принять на склад', 'ok');
            await loadSupplies();
            render();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
    onOpen: () => {
      window.__supplyOpts = catOpts;
      addSupplyRow();
    },
  });
}

function addSupplyRow() {
  const box = document.getElementById('sp-items');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'row gap-8 sp-row mb-8 wrap-row';
  row.innerHTML = `
    <select class="sp-c grow" style="min-width:220px">${window.__supplyOpts || ''}</select>
    <input class="sp-q" type="number" value="1" min="1" style="width:90px" title="Количество">
    <input class="sp-p" type="number" placeholder="закупочная" style="width:130px" title="Закупочная цена">
    <button class="icon-btn" onclick="this.closest('.sp-row').remove()" title="Убрать">✕</button>`;
  box.appendChild(row);
  // подставляем закупочную цену = розничная минус условные 10 %
  const sel = row.querySelector('.sp-c');
  const price = row.querySelector('.sp-p');
  sel.addEventListener('change', () => {
    const opt = sel.selectedOptions[0];
    if (opt && !price.value) price.value = Math.round(n2(opt.dataset.price) * 0.9);
  });
}

/* ============================ Клиенты ============================ */
function clientsTableHtml() {
  if (!state.clients.length) {
    return empty('👥', state.clientQ ? 'Клиенты не найдены' : 'Клиентов пока нет',
      'База заполняется автоматически при оформлении заказов, либо добавьте клиента вручную.',
      '<button class="btn btn-primary" onclick="newClient()">+ Добавить клиента</button>');
  }
  const sorted = state.clients.slice().sort((a, b) => (
    state.clientSort === 'sum' ? n2(b.orders_sum) - n2(a.orders_sum)
      : state.clientSort === 'name' ? String(a.full_name).localeCompare(String(b.full_name), 'ru')
        : n2(b.id) - n2(a.id)
  ));
  return `
    <div class="card card-pad-0">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th data-sort="name" style="cursor:pointer">Клиент</th>
            <th>Телефон</th>
            <th class="hide-xs">Email</th>
            <th class="hide-xs">Город</th>
            <th class="num">Заказов</th>
            <th class="num">Сумма</th>
          </tr></thead>
          <tbody>
            ${sorted.map((c) => `
              <tr class="clickable" data-client="${c.id}">
                <td><div class="cell-main">${esc(c.full_name)}</div>
                    ${c.note ? `<div class="cell-sub">${esc(c.note)}</div>` : ''}</td>
                <td class="mono nowrap">${esc(c.phone)}</td>
                <td class="hide-xs">${esc(c.email || '—')}</td>
                <td class="hide-xs">${esc(c.city || '—')}</td>
                <td class="num">${n2(c.orders_count)}</td>
                <td class="num cell-main">${money(c.orders_sum)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderClients() {
  document.getElementById('app').innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">Клиенты</h1>
        <div class="small muted">${state.clients.length} ${plural(state.clients.length, 'запись', 'записи', 'записей')} в базе</div>
      </div>
      <button class="btn btn-primary" onclick="newClient()">+ Добавить клиента</button>
    </div>
    <div class="card mb-16">
      <div class="row wrap-row gap-12">
        <div class="input-icon grow" style="min-width:240px">
          <span class="i">🔍</span>
          <input data-search-input placeholder="Имя, телефон или email" value="${esc(state.clientQ)}" oninput="onClientSearch(this.value)">
        </div>
        <div class="seg">
          <button class="${state.clientSort === 'id' ? 'active' : ''}" onclick="setClientSort('id')">Новые</button>
          <button class="${state.clientSort === 'sum' ? 'active' : ''}" onclick="setClientSort('sum')">По сумме</button>
          <button class="${state.clientSort === 'name' ? 'active' : ''}" onclick="setClientSort('name')">По имени</button>
        </div>
      </div>
    </div>
    ${clientsTableHtml()}`;
  bindClients();
}

const onClientSearch = debounce(async (v) => {
  state.clientQ = v;
  try { await loadClients(); renderClients(); PCB.keepSearchFocus(); } catch (e) { toast(e.message, 'err'); }
}, 260);

function setClientSort(s) { state.clientSort = s; renderClients(); }

function bindClients() {
  document.querySelectorAll('[data-client]').forEach((tr) => {
    tr.onclick = () => openClient(Number(tr.dataset.client));
  });
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.onclick = () => setClientSort(th.dataset.sort);
  });
}

async function openClient(id) {
  let data;
  try { data = await api(`/api/clients/${id}`); } catch (e) { return toast(e.message, 'err'); }
  const c = data.client;
  const orders = data.orders || [];

  const wrap = drawer({
    wide: true,
    title: esc(c.full_name),
    subtitle: `${esc(c.phone)}${c.email ? ' · ' + esc(c.email) : ''}`,
    body: `
      <div class="grid grid-3 gap-8">
        <div class="stat" style="--stat-accent:var(--brand)">
          <span class="stat-label">Заказов</span><span class="stat-value">${orders.length}</span></div>
        <div class="stat" style="--stat-accent:var(--ok)">
          <span class="stat-label">Сумма</span><span class="stat-value" style="font-size:20px">${money(orders.reduce((s, o) => s + n2(o.total), 0), { bare: false })}</span></div>
        <div class="stat" style="--stat-accent:var(--info)">
          <span class="stat-label">В работе</span><span class="stat-value">${orders.filter((o) => ACTIVE_STATUSES.includes(o.status)).length}</span></div>
      </div>

      <div class="block">
        <h4>Контакты и адрес</h4>
        <div class="form-grid">
          <div class="field"><label for="ed-name">Имя</label><input id="ed-name" value="${esc(c.full_name)}"></div>
          <div class="field"><label for="ed-phone">Телефон</label><input id="ed-phone" value="${esc(c.phone)}"></div>
          <div class="field"><label for="ed-email">Email</label><input id="ed-email" value="${esc(c.email || '')}"></div>
          <div class="field"><label for="ed-city">Город</label><input id="ed-city" value="${esc(c.city || '')}"></div>
          <div class="field full"><label for="ed-addr">Адрес</label><input id="ed-addr" value="${esc(c.address || '')}"></div>
          <div class="field full"><label for="ed-note">Заметка</label>
            <textarea id="ed-note" placeholder="Пожелания, история общения">${esc(c.note || '')}</textarea></div>
        </div>
        <button class="btn btn-primary" id="ed-save">Сохранить</button>
        <button class="btn btn-sm btn-ghost" onclick="PCB.copy('${esc(c.phone)}','Телефон скопирован')">Скопировать телефон</button>
      </div>

      <div class="block">
        <h4>Заказы клиента</h4>
        ${orders.length ? orders.map((o) => `
          <div class="item-row clickable" style="cursor:pointer" onclick="PCB.closeDrawer();openOrder(${o.id})">
            <span class="nm mono">${esc(o.order_no)}</span>
            ${badge(o.status, state.meta)}
            <span class="qty">${date(o.created_at).slice(0, 10)}</span>
            <b class="price">${money(o.total)}</b>
          </div>`).join('') : '<div class="small muted">Заказов нет</div>'}
      </div>

      <div class="block">
        <h4>Новый заказ для клиента</h4>
        <div class="row gap-8 wrap-row">
          <input id="cl-items" placeholder="Компоненты через запятую (название или ID)" class="grow">
          <button class="btn" id="cl-order">Создать заказ</button>
        </div>
        <div class="field-hint mt-8">Берём комплектующие из каталога по названию — так удобно принять заказ по телефону.</div>
      </div>`,
    foot: '<button class="btn btn-ghost" onclick="PCB.closeDrawer()">Закрыть</button>',
  });

  wrap.querySelector('#ed-save').onclick = async (e) => {
    try {
      await withBusy(e.currentTarget, () => api(`/api/clients/${id}`, {
        method: 'PATCH',
        body: {
          fullName: val('#ed-name'), phone: val('#ed-phone'), email: val('#ed-email'),
          city: val('#ed-city'), address: val('#ed-addr'), note: val('#ed-note'),
        },
      }));
      toast('Карточка клиента сохранена', 'ok');
      closeDrawer();
      await loadClients();
      renderClients();
    } catch (err) { toast(err.message, 'err'); }
  };

  wrap.querySelector('#cl-order').onclick = async (e) => {
    const raw = val('#cl-items');
    if (!raw) return toast('Укажите компоненты через запятую', 'warn');
    if (!state.catalog.length) await loadCatalog();
    const items = [];
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const found = state.catalog.find((c) => c.id === Number(part))
        || state.catalog.find((c) => c.name.toLowerCase() === part.toLowerCase())
        || state.catalog.find((c) => c.name.toLowerCase().includes(part.toLowerCase()));
      if (found) items.push({ componentId: found.id, qty: 1 });
    }
    if (!items.length) return toast('Ни один компонент не найден в каталоге', 'err');
    try {
      await withBusy(e.currentTarget, () => api('/api/orders', {
        method: 'POST',
        body: { clientId: id, items, deliveryType: 'courier', paymentMethod: 'card', comment: 'Заказ принят по телефону' },
      }));
      toast('Заказ создан', 'ok');
      closeDrawer();
      await reloadAll();
      render();
    } catch (err) { toast(err.message, 'err'); }
  };
}

function newClient() {
  modal({
    title: 'Новый клиент',
    body: `<div class="form-grid">
      <div class="field full"><label for="nc-name">Имя и фамилия <span class="req">*</span></label><input id="nc-name" placeholder="Иван Иванов"></div>
      <div class="field"><label for="nc-phone">Телефон <span class="req">*</span></label><input id="nc-phone" type="tel" placeholder="+79990000000"></div>
      <div class="field"><label for="nc-email">Email</label><input id="nc-email" placeholder="mail@example.com"></div>
      <div class="field"><label for="nc-city">Город</label><input id="nc-city" placeholder="Москва"></div>
      <div class="field"><label for="nc-pass">Пароль клиента <span class="req">*</span></label><input id="nc-pass" type="text" minlength="6" placeholder="минимум 6 символов"></div>
      <div class="field full"><label for="nc-addr">Адрес доставки</label><input id="nc-addr" placeholder="ул. Тверская, 7"></div>
      <div class="field full"><label for="nc-note">Заметка</label><input id="nc-note" placeholder="Постоянный клиент, предпочитает тихие сборки"></div>
    </div>
    <div class="notice"><span class="n-icon">🔐</span><span>Клиент сможет войти в кабинет по телефону и паролю — их можно поменять в его профиле.</span></div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Добавить клиента', cls: 'btn-primary', onClick: async (w) => {
          const password = val('#nc-pass');
          if (!password || password.length < 6) { toast('Пароль клиента — минимум 6 символов', 'err'); return; }
          try {
            await api('/api/clients', {
              method: 'POST',
              body: {
                fullName: val('#nc-name'), phone: val('#nc-phone'), email: val('#nc-email'),
                city: val('#nc-city'), address: val('#nc-addr'), note: val('#nc-note'),
                password,
              },
            });
            toast('Клиент добавлен', 'ok');
            await loadClients();
            renderClients();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
}

/* ============================ Склад ============================ */
function stockTableHtml() {
  const q = state.stockQ.toLowerCase().trim();
  const list = state.catalog.filter((c) => (
    (!state.stockCat || c.category === state.stockCat)
    && (!q || c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
  ));

  return `
    <div class="card card-pad-0">
      <div class="table-wrap" style="max-height:calc(100vh - 340px)">
        <table class="table">
          <thead><tr>
            <th>Категория</th><th>Компонент</th>
            <th class="num">Цена</th><th class="num">Склад</th><th class="num">Резерв</th>
            <th class="num">Изменить</th>
          </tr></thead>
          <tbody>
            ${list.map((c) => {
              const low = n2(c.stock) <= n2(c.min_stock);
              return `
              <tr>
                <td><span class="pill">${esc(c.category)}</span></td>
                <td><div class="cell-main">${esc(c.name)}</div>
                    ${low ? `<div class="cell-sub"><span class="chip warn">заканчивается</span></div>` : ''}</td>
                <td class="num">${money(c.price)}</td>
                <td class="num cell-main">${n2(c.stock)}</td>
                <td class="num muted">${n2(c.reserved)}</td>
                <td class="num nowrap">
                  <button class="btn btn-sm" data-stock="${c.id}" data-d="-1" title="Списать 1">−</button>
                  <button class="btn btn-sm" data-stock="${c.id}" data-d="1" title="Принять 1">+</button>
                  <button class="btn btn-sm" data-stock="${c.id}" data-d="5" title="Принять 5">+5</button>
                </td>
              </tr>`;
            }).join('') || '<tr><td colspan="6">' + empty('🔍', 'Ничего не найдено', 'Измените фильтр или запрос') + '</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderStock() {
  const cats = [...new Set(state.catalog.map((c) => c.category))];
  const totalValue = state.catalog.reduce((s, c) => s + n2(c.price) * n2(c.stock), 0);
  const totalUnits = state.catalog.reduce((s, c) => s + n2(c.stock), 0);
  const low = (state.stats && state.stats.lowStock) || [];

  document.getElementById('app').innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">Склад комплектующих</h1>
        <div class="small muted">${num(state.catalog.length)} позиций · ${num(totalUnits)} шт · суммарно ${money(totalValue)}</div>
      </div>
      <button class="btn btn-primary" onclick="newComponent()">+ Компонент</button>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="stat" style="--stat-accent:var(--brand)"><span class="stat-label">Позиций</span><span class="stat-value">${num(state.catalog.length)}</span></div>
      <div class="stat" style="--stat-accent:var(--info)"><span class="stat-label">Штук на складе</span><span class="stat-value">${num(totalUnits)}</span></div>
      <div class="stat" style="--stat-accent:var(--ok)"><span class="stat-label">Стоимость остатков</span><span class="stat-value" style="font-size:20px">${moneyShort(totalValue)} ₽</span></div>
      <div class="stat" style="--stat-accent:${low.length ? 'var(--warn)' : 'var(--ok)'}">
        <span class="stat-label">Заканчивается</span><span class="stat-value">${low.length}</span>
        <span class="stat-foot">порог из настроек</span></div>
    </div>

    <div class="card mb-16">
      <div class="row wrap-row gap-12">
        <div class="input-icon grow" style="min-width:240px">
          <span class="i">🔍</span>
          <input data-search-input placeholder="Название или категория" value="${esc(state.stockQ)}" oninput="onStockSearch(this.value)">
        </div>
        <div class="seg">
          <button class="${!state.stockCat ? 'active' : ''}" onclick="setStockCat('')">Все</button>
          ${cats.map((c) => `<button class="${state.stockCat === c ? 'active' : ''}" onclick="setStockCat('${esc(c)}')">${esc(c)}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid grid-sidebar">
      ${stockTableHtml()}
      <div class="card">
        <div class="row-between mb-12">
          <h3 style="margin:0">Заканчивается</h3>
          <span class="chip ${low.length ? 'warn' : 'ok'}">${low.length}</span>
        </div>
        ${low.length ? low.map((c) => `
          <div class="item-row">
            <span class="nm">${esc(c.name)}</span>
            <span class="chip ${n2(c.stock) === 0 ? 'err' : 'warn'}">${n2(c.stock)} шт</span>
          </div>`).join('') : '<div class="small muted">Всё в наличии</div>'}
      </div>
    </div>`;
  bindStock();
}

const onStockSearch = debounce((v) => { state.stockQ = v; renderStock(); PCB.keepSearchFocus(); }, 200);
function setStockCat(cat) { state.stockCat = cat; renderStock(); }

function bindStock() {
  document.querySelectorAll('[data-stock]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/components/${b.dataset.stock}/stock`, { method: 'POST', body: { delta: Number(b.dataset.d) } });
        await loadCatalog();
        await reloadAll();
        renderStock();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function newComponent() {
  const cats = [...new Set([...state.catalog.map((c) => c.category), 'CPU', 'GPU', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Motherboard'])];
  modal({
    wide: true,
    title: 'Новый компонент',
    body: `<div class="form-grid">
      <div class="field"><label for="nc-comp-cat">Категория</label>
        <select id="nc-comp-cat">${options(Object.fromEntries(cats.map((c) => [c, c])), 'CPU')}</select></div>
      <div class="field"><label for="nc-comp-price">Цена, ₽</label><input id="nc-comp-price" type="number" value="10000"></div>
      <div class="field full"><label for="nc-comp-name">Название <span class="req">*</span></label>
        <input id="nc-comp-name" placeholder="AMD Ryzen 7 7800X3D"></div>
      <div class="field full"><label for="nc-comp-desc">Описание</label>
        <input id="nc-comp-desc" placeholder="8 ядер, AM5"></div>
      <div class="field"><label for="nc-comp-socket">Сокет</label><input id="nc-comp-socket" placeholder="AM5"></div>
      <div class="field"><label for="nc-comp-ram">Тип памяти</label><input id="nc-comp-ram" placeholder="DDR5"></div>
      <div class="field"><label for="nc-comp-tdp">TDP, Вт</label><input id="nc-comp-tdp" type="number" placeholder="120"></div>
      <div class="field"><label for="nc-comp-w">Мощность / Вт</label><input id="nc-comp-w" type="number" placeholder="650"></div>
      <div class="field"><label for="nc-comp-stock">Остаток</label><input id="nc-comp-stock" type="number" value="3"></div>
      <div class="field"><label for="nc-comp-min">Порог «заканчивается»</label><input id="nc-comp-min" type="number" value="3"></div>
    </div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Добавить', cls: 'btn-primary', onClick: async () => {
          try {
            await api('/api/components', {
              method: 'POST',
              body: {
                category: val('#nc-comp-cat'), name: val('#nc-comp-name'),
                description: val('#nc-comp-desc'), price: val('#nc-comp-price'),
                socket: val('#nc-comp-socket'), ramType: val('#nc-comp-ram'),
                tdp: val('#nc-comp-tdp') || null, wattage: val('#nc-comp-w') || null,
                stock: val('#nc-comp-stock'), minStock: val('#nc-comp-min') || 3,
              },
            });
            toast('Компонент добавлен в каталог', 'ok');
            await loadCatalog();
            await reloadAll();
            renderStock();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
}

/* ============================ Настройки ============================ */
/* ============================ SMS-УВЕДОМЛЕНИЯ ============================ */
const SMS_STATUS = {
  sent: { label: 'отправлено', cls: 'ok' },
  failed: { label: 'ошибка', cls: 'err' },
  skipped: { label: 'пропущено', cls: 'warn' },
};
const EVENT_TITLE = {
  paid: 'Оплата', purchasing: 'Закупка', assembling: 'Сборка', ready: 'Готов',
  shipped: 'Отправлено', out_for_delivery: 'Курьер', arrived: 'Прибыло', delivered: 'Получено',
  cancelled: 'Отменён', custom: 'Произвольное',
};

async function loadSms() {
  state.sms = await api(`/api/sms?limit=150${state.smsFilter ? `&status=${state.smsFilter}` : ''}`).catch(() => null);
}

function renderSms() {
  const data = state.sms;
  const st = (data && data.stats) || {};
  const rows = (data && data.rows) || [];
  const v = (data && data.stats && data.stats.templates) || {};
  const values = (state.settings && state.settings.values) || {};
  const provider = values['sms.provider'] || 'log';
  const enabled = st.enabled === true;
  const providerInfo = (data && data.providers.find((p) => p.id === provider)) || { hint: '' };

  document.getElementById('app').innerHTML = `
    <div class="row-between mb-16 wrap-row gap-12">
      <div>
        <h1 style="margin:0">SMS-уведомления</h1>
        <div class="small muted">Клиент получает сообщения на каждом этапе: оплата → сборка → отправлено → прибыло → получено</div>
      </div>
      <div class="row gap-8">
        <span class="chip ${enabled ? 'ok' : ''}">${enabled ? 'уведомления включены' : 'уведомления выключены'}</span>
        <button class="btn btn-sm" onclick="smsRefresh()">🔄 Обновить</button>
      </div>
    </div>

    <div class="grid grid-4 mb-16" style="gap:14px">
      <div class="stat"><span class="stat-label">Сегодня</span><span class="stat-value">${n2(st.today || 0)}</span><span class="stat-foot">сообщений</span></div>
      <div class="stat"><span class="stat-label">Доставлено</span><span class="stat-value" style="color:var(--ok)">${n2(st.sent || 0)}</span><span class="stat-foot">из ${n2(st.total || 0)}</span></div>
      <div class="stat"><span class="stat-label">Ошибки</span><span class="stat-value" style="color:${(st.failed || 0) ? 'var(--danger)' : 'inherit'}">${n2(st.failed || 0)}</span><span class="stat-foot">проверьте канал</span></div>
      <div class="stat"><span class="stat-label">Канал</span><span class="stat-value" style="font-size:18px">${esc(provider)}</span><span class="stat-foot">${enabled ? 'работает' : 'выключен'}</span></div>
    </div>

    <div class="grid grid-sidebar">
      <div class="grid" style="gap:14px">
        <div class="card">
          <h3 class="mb-12">Канал отправки</h3>
          <div class="notice mb-16"><span class="n-icon">💡</span>
            <span>${esc(providerInfo.hint)}. Пока выбран «журнал» — тексты пишутся в <span class="mono">data/sms.log</span>, их видно клиенту в кабинете, но на телефон ничего не уходит.</span></div>
          <div class="form-grid">
            <div class="field full">
              <label>Провайдер</label>
              <select id="sms-provider">
                ${(data ? data.providers : []).map((p) => `<option value="${p.id}" ${p.id === provider ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>API ID / логин</label><input id="sms-login" value="${esc(values['sms.login'] || '')}" placeholder="SMSC.ru"></div>
            <div class="field"><label>Пароль</label><input id="sms-pass" type="password" value="${esc(values['sms.password'] || '')}" placeholder="не изменён"></div>
            <div class="field"><label>Имя отправителя</label><input id="sms-sender" value="${esc(values['sms.sender'] || '')}" placeholder="PCBuild"></div>
            <div class="field"><label>Адрес сайта в ссылках</label><input id="sms-link" value="${esc(values['sms.linkBase'] || '')}" placeholder="https://ваш-сайт.ru"></div>
            <div class="field full"><label>Webhook (для своего шлюза)</label><input id="sms-hook" value="${esc(values['sms.webhookUrl'] || '')}" placeholder="https://…"></div>
          </div>
          <div class="row gap-12 wrap-row mt-12">
            <label class="sms-check">
              <input type="checkbox" id="sms-enabled" ${enabled ? 'checked' : ''}>
              <span>Присылать уведомления клиентам</span>
            </label>
            <button class="btn btn-primary" id="sms-save">Сохранить канал</button>
            <button class="btn" id="sms-test">✉ Отправить себе тест</button>
          </div>
        </div>

        <div class="card">
          <div class="row-between mb-12">
            <h3 style="margin:0">Тексты сообщений</h3>
            <span class="small muted">Подстановки: ${((data && data.placeholders) || []).map((p) => `<span class="mono">${esc(p)}</span>`).join(' ')}</span>
          </div>
          <div class="grid" style="gap:12px">
            ${(data ? data.events : []).map((e) => `
              <div class="field">
                <label>${esc(e.title)} — <span class="muted">${esc(e.when)}</span></label>
                <textarea id="sms-tpl-${e.id}" rows="2" class="sms-textarea">${esc(v[e.id] || '')}</textarea>
              </div>`).join('')}
          </div>
          <button class="btn btn-primary mt-12" id="sms-save-tpl">Сохранить тексты</button>
        </div>
      </div>

      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="row-between mb-12">
            <h3 style="margin:0">Журнал</h3>
            <select id="sms-filter" style="max-width:150px">
              <option value="" ${!state.smsFilter ? 'selected' : ''}>все</option>
              <option value="sent" ${state.smsFilter === 'sent' ? 'selected' : ''}>доставлено</option>
              <option value="failed" ${state.smsFilter === 'failed' ? 'selected' : ''}>ошибки</option>
              <option value="skipped" ${state.smsFilter === 'skipped' ? 'selected' : ''}>пропущено</option>
            </select>
          </div>
          ${rows.length ? `<div class="list sms-journal">
            ${rows.map((m) => `
              <div class="item-row" style="align-items:flex-start">
                <span class="chip ${(SMS_STATUS[m.status] || {}).cls || ''}">${esc((SMS_STATUS[m.status] || {}).label || m.status)}</span>
                <span class="nm sms-text">
                  <b>${esc(EVENT_TITLE[m.event] || m.event)}</b>${m.order_no ? ` · ${esc(m.order_no)}` : ''}
                  <div class="sms-sub">${esc(m.text)}</div>
                  <div class="sms-sub">${esc(m.phone || '—')} · ${ago(m.created_at)}${m.error ? ` · ${esc(m.error)}` : ''}</div>
                </span>
              </div>`).join('')}
          </div>` : empty('📱', 'Сообщений пока нет', 'Как только сменится этап заказа, здесь появится текст, который ушёл клиенту.')}
        </div>

        <div class="card">
          <h3 class="mb-8">Что отправляется клиенту</h3>
          ${(data ? data.events : []).map((e) => `
            <div class="item-row"><span class="nm">${esc(e.title)}</span><span class="xs muted">${esc(e.when)}</span></div>`).join('')}
          <div class="field-hint mt-8">Клиент может отключить уведомления в кабинете (Профиль → SMS) — тогда сообщения не отправляются.</div>
        </div>
      </div>
    </div>`;

  const $ = (s) => document.querySelector(s);
  $('#sms-filter').onchange = async (e) => { state.smsFilter = e.target.value; await loadSms(); renderSms(); };

  $('#sms-save').onclick = async (e) => {
    const pass = $('#sms-pass').value;
    const body = {
      'sms.provider': $('#sms-provider').value,
      'sms.login': $('#sms-login').value,
      'sms.sender': $('#sms-sender').value,
      'sms.linkBase': $('#sms-link').value,
      'sms.webhookUrl': $('#sms-hook').value,
      'sms.enabled': $('#sms-enabled').checked,
    };
    if (pass && pass !== '••••••' && pass !== 'не изменён') body['sms.password'] = pass;
    try {
      await withBusy(e.currentTarget, () => api('/api/settings', { method: 'PATCH', body }));
      toast('Канал сохранён', 'ok');
      await loadSettings(); await loadSms(); renderSms();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#sms-save-tpl').onclick = async (e) => {
    const body = {};
    (data.events || []).forEach((ev) => { body[`sms.tpl.${ev.id}`] = $(`#sms-tpl-${ev.id}`).value; });
    try {
      await withBusy(e.currentTarget, () => api('/api/settings', { method: 'PATCH', body }));
      toast('Тексты сохранены', 'ok');
      await loadSms(); renderSms();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#sms-test').onclick = async (e) => {
    const phone = prompt('Номер для тестового сообщения:', state.me.phone || '+79990000000');
    if (!phone) return;
    try {
      await withBusy(e.currentTarget, () => api('/api/sms/test', { method: 'POST', body: { phone } }));
      await loadSms();
      toast('Тестовое сообщение обработано — смотрите журнал', 'ok');
      renderSms();
    } catch (err) { toast(err.message, 'err'); }
  };
}

/** Кнопка «SMS» в карточке заказа: история уведомлений и ручная отправка. */
async function smsModal(orderId) {
  const o = state.orders.find((x) => String(x.id) === String(orderId));
  const data = await api(`/api/orders/${orderId}`);
  const msgs = data.messages || [];
  const wrap = modal({
    title: `SMS клиенту · ${o ? o.order_no : ''}`,
    body: `
      <div class="small muted mb-12">${esc(data.client.full_name || '')} · ${esc(data.client.phone || 'телефон не указан')}</div>
      ${msgs.length ? `<div class="list mb-16" style="max-height:240px;overflow:auto">
        ${msgs.map((m) => `
          <div class="item-row" style="align-items:flex-start">
            <span class="chip ${(SMS_STATUS[m.status] || {}).cls || ''}">${esc((SMS_STATUS[m.status] || {}).label || m.status)}</span>
            <span class="nm sms-text"><div>${esc(m.text)}</div><div class="sms-sub">${esc(EVENT_TITLE[m.event] || m.event)} · ${ago(m.created_at)}</div></span>
          </div>`).join('')}
      </div>` : '<div class="notice mb-16"><span class="n-icon">📱</span><span>Уведомлений по заказу ещё не было.</span></div>'}
      <div class="field">
        <label>Свой текст (необязательно — если пусто, уйдёт шаблон события)</label>
        <textarea id="sms-manual" rows="3" class="sms-textarea" placeholder="Например: добрый день, комплектующие приехали, завтра собираем"></textarea>
      </div>
      <div class="row gap-8 wrap-row">
        <button class="btn btn-primary" id="sms-send-order">Отправить шаблонное</button>
        <button class="btn" id="sms-send-custom">Отправить свой текст</button>
      </div>`,
  });
  const send = async (custom) => {
    const text = custom ? (wrap.querySelector('#sms-manual').value || '').trim() : '';
    try {
      const r = await api('/api/sms/send', { method: 'POST', body: { orderId: Number(orderId), text } });
      if (r.ok) { toast('Сообщение отправлено', 'ok'); closeModal(); smsModal(orderId); }
      else toast(r.error || 'Не отправлено', 'warn');
    } catch (err) { toast(err.message, 'err'); }
  };
  wrap.querySelector('#sms-send-order').onclick = () => send(false);
  wrap.querySelector('#sms-send-custom').onclick = () => send(true);
  await loadSms();
}

function smsRefresh() { loadSms().then(renderSms); }

function renderSettings() {
  const s = state.settings || { requisites: {}, fees: { assembly: 0, delivery: {} } };
  const h = state.health || {};
  const r = s.requisites;

  document.getElementById('app').innerHTML = `
    <div class="mb-16">
      <h1 style="margin:0">Настройки</h1>
      <div class="small muted">Реквизиты, тарифы, команда и состояние базы — всё хранится в SQLite</div>
    </div>

    <div class="grid grid-sidebar">
      <div class="grid" style="gap:14px">
        <div class="card">
          <h3 class="mb-12">Реквизиты компании</h3>
          <div class="notice mb-16"><span class="n-icon">🧾</span>
            <span>Эти данные подставляются в печатные формы: заказ-наряд, счёт и акт приёма-передачи.</span></div>
          <div class="form-grid">
            <div class="field"><label>Название</label><input id="s-c-name" value="${esc(r.name || '')}"></div>
            <div class="field"><label>Бренд</label><input id="s-c-brand" value="${esc(r.brand || '')}"></div>
            <div class="field full"><label>Описание</label><input id="s-c-tag" value="${esc(r.tagline || '')}"></div>
            <div class="field"><label>ИНН</label><input id="s-c-inn" value="${esc(r.inn || '')}"></div>
            <div class="field"><label>КПП</label><input id="s-c-kpp" value="${esc(r.kpp || '')}"></div>
            <div class="field full"><label>Расчётный счёт</label><input id="s-c-acc" value="${esc(r.account || '')}"></div>
            <div class="field"><label>Банк</label><input id="s-c-bank" value="${esc(r.bank || '')}"></div>
            <div class="field"><label>БИК</label><input id="s-c-bic" value="${esc(r.bic || '')}"></div>
            <div class="field full"><label>Корреспондентский счёт</label><input id="s-c-corr" value="${esc(r.corr || '')}"></div>
            <div class="field"><label>Телефон</label><input id="s-c-phone" value="${esc(r.phone || '')}"></div>
            <div class="field"><label>Email</label><input id="s-c-email" value="${esc(r.email || '')}"></div>
            <div class="field full"><label>Адрес</label><input id="s-c-addr" value="${esc(r.address || '')}"></div>
            <div class="field full"><label>Часы работы</label><input id="s-c-hours" value="${esc(r.workHours || '')}"></div>
          </div>
          <button class="btn btn-primary" id="save-company">Сохранить реквизиты</button>
        </div>

        <div class="card">
          <h3 class="mb-12">Тарифы</h3>
          <div class="notice mb-16"><span class="n-icon">💡</span>
            <span>Тарифы применяются ко всем новым заказам: в расчёте и в печатных документах.</span></div>
          <div class="form-grid">
            <div class="field"><label>Сборка и тестирование, ₽</label>
              <input id="s-f-assembly" type="number" value="${n2(s.fees.assembly)}"></div>
            <div class="field"><label>Порог «заканчивается»</label>
              <input id="s-low" type="number" value="3"></div>
            ${Object.entries(s.fees.delivery).map(([k, v]) => `
              <div class="field"><label>${esc(state.meta.deliveryTypes[k] || k)}, ₽</label>
                <input id="s-f-d-${esc(k)}" type="number" value="${n2(v)}"></div>`).join('')}
          </div>
          <button class="btn btn-primary" id="save-fees">Сохранить тарифы</button>
        </div>

        <div class="card">
          <div class="row-between mb-12">
            <h3 style="margin:0">Команда</h3>
            ${state.me.role === 'admin' ? '<button class="btn btn-sm btn-primary" onclick="newStaff()">+ Сотрудник</button>' : ''}
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Сотрудник</th><th class="hide-xs">Логин</th><th>Роль</th><th class="num">Заказов</th><th class="num">В работе</th></tr></thead>
              <tbody>
                ${state.staff.map((u) => `
                  <tr>
                    <td class="cell-main">${esc(u.full_name)}<div class="cell-sub">${esc(u.phone || '')}</div></td>
                    <td class="hide-xs mono">${esc(u.login)}</td>
                    <td>${u.role === 'admin' ? '<span class="chip info">админ</span>' : '<span class="chip">сборщик</span>'}</td>
                    <td class="num">${n2(u.orders_count)}</td>
                    <td class="num">${n2(u.wip) ? `<span class="chip warn">${n2(u.wip)}</span>` : '—'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="row-between mb-12">
            <h3 style="margin:0">База данных</h3>
            <span class="chip ${h.ok ? 'ok' : 'err'}">${h.ok ? 'целостна' : 'проверьте'}</span>
          </div>
          <div class="small muted mb-8">Драйвер: <b>${esc(h.driver || '—')}</b>${h.node ? ` · Node ${esc(h.node)}` : ''}</div>
          <div class="item-row"><span class="nm">Режим журналирования</span><b>WAL</b></div>
          <div class="item-row"><span class="nm">Проверка целостности</span>
            <span class="chip ${h.integrity === 'ok' ? 'ok' : 'err'}">${esc(h.integrity || '—')}</span></div>
          <div class="item-row"><span class="nm">Ошибок внешних ключей</span>
            <span class="chip ${n2(h.foreignKeyErrors) === 0 ? 'ok' : 'warn'}">${n2(h.foreignKeyErrors)}</span></div>
          <div class="item-row"><span class="nm">Время работы сервера</span><b>${Math.floor((h.uptimeSec || 0) / 60)} мин</b></div>
          ${h.counts ? Object.entries(h.counts).slice(0, 6).map(([k, v]) => `
            <div class="item-row"><span class="nm">${esc(k)}</span><b>${num(v)}</b></div>`).join('') : ''}
          <div class="grid mt-12" style="gap:8px">
            <button class="btn btn-block" onclick="window.open('/api/health','_blank')">Открыть /api/health</button>
            <button class="btn btn-block btn-primary" onclick="downloadBackup()">⬇ Скачать резервную копию</button>
          </div>
          <div class="field-hint mt-8">Копия делается консистентно (VACUUM INTO) и кладётся в <span class="mono">data/backups</span>.</div>
        </div>

        <div class="card">
          <h3 class="mb-8">Горячие клавиши</h3>
          <div class="item-row"><span class="nm">Ctrl / ⌘ + K</span><span class="xs muted">поиск на странице</span></div>
          <div class="item-row"><span class="nm">Esc</span><span class="xs muted">закрыть окно или меню</span></div>
          <div class="item-row"><span class="nm">Перетаскивание</span><span class="xs muted">статус заказа в канбане</span></div>
        </div>

        <div class="card">
          <h3 class="mb-8">Быстрые переходы</h3>
          <div class="grid" style="gap:8px">
            <a class="btn btn-block" href="/">Главная</a>
            <a class="btn btn-block" href="/builder">Конфигуратор ПК</a>
            <a class="btn btn-block" href="/track">Отслеживание</a>
            <a class="btn btn-block" href="/client">Кабинет клиента</a>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('save-company').onclick = async (e) => {
    try {
      await withBusy(e.currentTarget, () => api('/api/settings', {
        method: 'PATCH',
        body: {
          'company.name': val('#s-c-name'), 'company.brand': val('#s-c-brand'), 'company.tagline': val('#s-c-tag'),
          'company.inn': val('#s-c-inn'), 'company.kpp': val('#s-c-kpp'), 'company.account': val('#s-c-acc'),
          'company.bank': val('#s-c-bank'), 'company.bic': val('#s-c-bic'), 'company.corr': val('#s-c-corr'),
          'company.phone': val('#s-c-phone'), 'company.email': val('#s-c-email'),
          'company.address': val('#s-c-addr'), 'company.workHours': val('#s-c-hours'),
        },
      }));
      toast('Реквизиты сохранены — печатные формы обновятся сразу', 'ok');
      await loadSettings();
      await meta(true);
    } catch (err) { toast(err.message, 'err'); }
  };

  document.getElementById('save-fees').onclick = async (e) => {
    try {
      const body = {
        'fees.assembly': val('#s-f-assembly'),
        'stock.lowThreshold': val('#s-low'),
      };
      Object.keys(s.fees.delivery).forEach((k) => { body[`fees.delivery.${k}`] = val(`#s-f-d-${k}`); });
      await withBusy(e.currentTarget, () => api('/api/settings', { method: 'PATCH', body }));
      toast('Тарифы сохранены', 'ok');
      await loadSettings();
      await meta(true);
      await reloadAll();
      render();
    } catch (err) { toast(err.message, 'err'); }
  };
}

function newStaff() {
  modal({
    title: 'Новый сотрудник',
    body: `<div class="form-grid">
      <div class="field full"><label>Имя и фамилия <span class="req">*</span></label><input id="ns-name" placeholder="Сергей Сборщиков"></div>
      <div class="field"><label>Логин <span class="req">*</span></label><input id="ns-login" placeholder="sbor2"></div>
      <div class="field"><label>Пароль <span class="req">*</span></label><input id="ns-pass" type="text" value="pass12345"></div>
      <div class="field"><label>Телефон</label><input id="ns-phone" placeholder="+7 (999) 000-00-02"></div>
      <div class="field"><label>Роль</label>
        <select id="ns-role"><option value="assembler">Сборщик</option><option value="admin">Администратор</option></select></div>
    </div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Создать', cls: 'btn-primary', onClick: async () => {
          try {
            await api('/api/staff', {
              method: 'POST',
              body: {
                fullName: val('#ns-name'), login: val('#ns-login'), password: val('#ns-pass'),
                phone: val('#ns-phone'), role: val('#ns-role'),
              },
            });
            toast('Сотрудник добавлен', 'ok');
            await reloadAll();
            render();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
}

function downloadBackup() {
  toast('Готовим резервную копию…');
  const a = document.createElement('a');
  a.href = '/api/admin/backup';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ============================ Новый заказ сборщиком ============================ */
const BUILD_CATS = ['CPU', 'Motherboard', 'RAM', 'GPU', 'PSU', 'Case', 'Storage', 'Cooler'];

async function newOrder() {
  if (!state.catalog.length) {
    try { await loadCatalog(); } catch (e) { return toast(e.message, 'err'); }
  }
  if (!state.clients.length) {
    try { await loadClients(); } catch (e) { /* клиентов может не быть */ }
  }

  const clientOpts = state.clients
    .map((c) => `<option value="${c.id}">${esc(c.full_name)} · ${esc(c.phone)}</option>`).join('');
  const m = state.meta;

  modal({
    wide: true,
    title: 'Новый заказ',
    body: `
      ${state.clients.length ? '' : '<div class="notice warn mb-16"><span class="n-icon">⚠️</span><span>В базе нет клиентов — добавьте клиента, иначе заказ некуда привязать.</span></div>'}
      <div class="form-grid">
        <div class="field"><label for="nb-client">Клиент</label>
          <select id="nb-client"><option value="">— выберите клиента —</option>${clientOpts}</select></div>
        <div class="field"><label for="nb-deliv">Доставка</label>
          <select id="nb-deliv">${options(m.deliveryTypes, 'courier')}</select></div>
        <div class="field"><label for="nb-pay">Оплата</label>
          <select id="nb-pay">${options(m.paymentMethods, 'card')}</select></div>
        <div class="field"><label for="nb-comment">Комментарий</label>
          <input id="nb-comment" placeholder="по телефону, тихая сборка"></div>
      </div>
      <h4 style="margin:14px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Комплектация</h4>
      <div class="form-grid">
        ${BUILD_CATS.map((cat) => {
          const items = state.catalogByCat[cat] || [];
          return `<div class="field"><label>${esc(cat)}</label>
            <select data-cat="${cat}">
              <option value="">— не выбрано —</option>
              ${items.map((c) => `<option value="${c.id}">${esc(c.name)} — ${money(c.price)}</option>`).join('')}
            </select></div>`;
        }).join('')}
      </div>
      <div class="notice mt-16"><span class="n-icon">ℹ️</span>
        <span>Заказ создаётся от имени клиента: он увидит его в кабинете и сможет оплатить.
        Стоимость сборки и доставки посчитается по тарифам из настроек.</span></div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Создать заказ', cls: 'btn-primary', onClick: async () => {
          const clientId = Number(val('#nb-client'));
          if (!clientId) return toast('Выберите клиента', 'err');
          const items = [...document.querySelectorAll('select[data-cat]')]
            .filter((s) => s.value)
            .map((s) => ({ componentId: Number(s.value), qty: 1 }));
          if (!items.length) return toast('Выберите хотя бы один компонент', 'err');
          try {
            const created = await api('/api/orders', {
              method: 'POST',
              body: {
                clientId,
                items,
                deliveryType: val('#nb-deliv'), paymentMethod: val('#nb-pay'),
                comment: val('#nb-comment'),
              },
            });
            toast(`Заказ ${created.order.order_no} создан`, 'ok');
            await reloadAll();
            syncNav();
            render();
            if (created.order) setTimeout(() => openOrder(created.order.id), 200);
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
}

/* ============================ Модалки логистики ============================ */
function shipModal(o) {
  const carriers = state.meta.carriers.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const eta = new Date(Date.now() + 3 * 86400000).toLocaleDateString('ru-RU');
  modal({
    title: `Отправка заказа ${esc(o.order_no)}`,
    body: `
      <div class="form-grid">
        <div class="field"><label for="sh-carrier">Перевозчик</label><select id="sh-carrier">${carriers}</select></div>
        <div class="field"><label for="sh-cost">Стоимость доставки, ₽</label><input id="sh-cost" type="number" value="${n2(o.delivery_cost)}"></div>
        <div class="field"><label for="sh-weight">Вес, кг</label><input id="sh-weight" type="number" value="12"></div>
        <div class="field"><label for="sh-eta">Ожидаемая дата</label><input id="sh-eta" value="${eta}"></div>
        <div class="field full"><label for="sh-addr">Адрес доставки</label><input id="sh-addr" value="${esc(o.address || '')}"></div>
        <div class="field full"><label for="sh-note">Комментарий перевозчику</label><input id="sh-note" placeholder="хрупкое, стекло"></div>
      </div>
      <div class="notice mt-16"><span class="n-icon">🔑</span>
        <span>После оформления клиент получит трек-номер и 4-значный код подтверждения из накладной.</span></div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Оформить отправку', cls: 'btn-primary', onClick: async () => {
          try {
            await api(`/api/orders/${o.id}/ship`, {
              method: 'POST',
              body: {
                carrier: val('#sh-carrier'), cost: val('#sh-cost'), weight: val('#sh-weight'),
                eta: val('#sh-eta'), address: val('#sh-addr'), comment: val('#sh-note'),
              },
            });
            toast('Отправление создано', 'ok');
            await reloadAll();
            render();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
}

function trackModal(o) {
  const opts = Object.entries(state.meta.shipmentStatuses)
    .map(([k, v]) => `<option value="${k}" ${k === 'in_transit' ? 'selected' : ''}>${esc(v)}</option>`).join('');
  modal({
    title: `Событие доставки · ${esc(o.track_number || '')}`,
    body: `
      <div class="field"><label for="tr-status">Статус</label><select id="tr-status">${opts}</select></div>
      <div class="field"><label for="tr-loc">Локация</label><input id="tr-loc" placeholder="Москва, сортировочный центр"></div>
      <div class="field"><label for="tr-note">Комментарий</label><input id="tr-note" placeholder="Курьер свяжется за час"></div>`,
    actions: [
      { label: 'Отмена', cls: 'btn-ghost' },
      {
        label: 'Добавить событие', cls: 'btn-primary', onClick: async () => {
          try {
            await api(`/api/orders/${o.id}/tracking`, {
              method: 'POST',
              body: { status: val('#tr-status'), location: val('#tr-loc'), note: val('#tr-note') },
            });
            toast('Событие добавлено — клиент увидит его на странице трекинга', 'ok');
            await reloadAll();
            render();
          } catch (e) { toast(e.message, 'err'); }
        },
      },
    ],
  });
}

boot().catch((e) => toast(e.message, 'err'));