/* ============================================================================
   PCBuilder ERP — общий слой для интерфейсов.
   Тема, хеш-роутер, запросы к API, тосты, модалки, drawer, форматирование.
   Никаких зависимостей: один файл, работает офлайн.
   ========================================================================== */
window.PCB = (() => {
  /* ---------------------------- утилиты ---------------------------- */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const n2 = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const money = (v, opts = {}) => {
    const n = n2(v);
    const hasCents = Math.abs(n % 1) > 0.004;
    const s = n.toLocaleString('ru-RU', {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0,
    });
    return opts.bare ? s : `${s} ₽`;
  };

  /** Компактная сумма для дашборда: 1,2 млн / 845 тыс. */
  const moneyShort = (v) => {
    const n = n2(v);
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн`;
    if (Math.abs(n) >= 1e4) return `${Math.round(n / 1e3)} тыс.`;
    return n.toLocaleString('ru-RU');
  };

  const num = (v) => n2(v).toLocaleString('ru-RU');

  const date = (s, withTime = true) => {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d)) return String(s);
    const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString('ru-RU', opts);
  };

  const dateShort = (s) => {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d)) return String(s);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  };

  /** «5 мин назад», «вчера», «3 дня назад» — для лент событий. */
  const ago = (s) => {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d)) return '';
    const diff = Math.round((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
    if (diff < 172800) return 'вчера';
    const days = Math.floor(diff / 86400);
    if (days < 30) return `${days} дн назад`;
    return dateShort(s);
  };

  const plural = (n, one, few, many) => {
    const a = Math.abs(n2(n)) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  };

  const debounce = (fn, ms = 250) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  const val = (sel, root = document) => {
    const el = root.querySelector(sel);
    return el ? String(el.value).trim() : '';
  };

  /* ---------------------------- тема ---------------------------- */
  const THEME_KEY = 'pcb.theme';
  const theme = {
    get() {
      try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
    },
    resolved() {
      const pref = theme.get();
      if (pref !== 'auto') return pref;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    apply(mode) {
      const value = mode === 'auto' ? theme.resolved() : mode;
      document.documentElement.setAttribute('data-theme', value);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', value === 'dark' ? '#0A0A11' : '#FFFFFF');
      const btn = document.getElementById('theme-btn');
      if (btn) btn.textContent = value === 'dark' ? '☀️' : '🌙';
    },
    set(mode) {
      try { localStorage.setItem(THEME_KEY, mode); } catch { /* приватный режим */ }
      theme.apply(mode);
    },
    toggle() {
      theme.set(theme.resolved() === 'dark' ? 'light' : 'dark');
    },
    init() {
      theme.apply(theme.get());
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (theme.get() === 'auto') theme.apply('auto');
      });
    },
  };

  /* ---------------------------- сеть ---------------------------- */
  async function api(url, opts = {}) {
    let res;
    try {
      res = await fetch(url, {
        credentials: 'same-origin',
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new Error('Нет связи с сервером. Проверьте, что PCBuilder ERP запущен.');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Ошибка запроса (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------------------- тосты ---------------------------- */
  const TOAST_ICON = { ok: '✅', err: '⛔', warn: '⚠️', info: 'ℹ️' };

  function toast(msg, type = 'info', ms = 3600) {
    const box = document.getElementById('toasts') || (() => {
      const d = document.createElement('div');
      d.id = 'toasts';
      d.className = 'toasts';
      document.body.appendChild(d);
      return d;
    })();
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role', type === 'err' ? 'alert' : 'status');
    t.innerHTML = `<span class="t-icon">${TOAST_ICON[type] || TOAST_ICON.info}</span><span>${esc(msg)}</span>`;
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, ms);
    return t;
  }

  /* ---------------------------- модалки ---------------------------- */
  function closeModal() {
    const wrap = document.getElementById('modal-wrap');
    if (wrap) {
      wrap.previousElementSibling && wrap.previousElementSibling.remove();
      wrap.remove();
    }
    document.body.style.overflow = '';
  }

  /**
   * modal({ title, body, wide, actions:[{label, cls, onClick, keepOpen}], onOpen })
   * onClick получает текущий wrap модалки.
   */
  function modal({ title = '', body = '', wide = false, actions = [], onOpen } = {}) {
    closeModal();
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const wrap = document.createElement('div');
    wrap.id = 'modal-wrap';
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${title}</h3>
          <button class="icon-btn" data-close aria-label="Закрыть">✕</button>
        </div>
        <div class="modal-body">${typeof body === 'string' ? body : ''}</div>
        <div class="modal-actions"></div>
      </div>`;
    document.body.append(scrim, wrap);
    document.body.style.overflow = 'hidden';

    const bodyEl = wrap.querySelector('.modal-body');
    if (body instanceof Node) bodyEl.appendChild(body);

    const acts = wrap.querySelector('.modal-actions');
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || 'btn-ghost');
      b.innerHTML = a.icon ? `<span>${a.icon}</span>` : '';
      b.appendChild(document.createTextNode(a.label));
      b.onclick = async () => {
        if (a.keepOpen) return a.onClick && a.onClick(wrap);
        closeModal();
        return a.onClick && a.onClick(wrap);
      };
      acts.appendChild(b);
    });

    wrap.querySelector('[data-close]').onclick = closeModal;
    scrim.onclick = closeModal;
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
    document.addEventListener('keydown', escClose);

    // фокус на первое поле — как в нормальных приложениях
    setTimeout(() => {
      const first = wrap.querySelector('input:not([type=hidden]), select, textarea');
      if (first) first.focus();
    }, 60);
    if (onOpen) onOpen(wrap);
    return wrap;
  }

  function escClose(e) {
    if (e.key === 'Escape') { closeModal(); closeDrawer(); closeMenus(); }
  }

  /** Диалог подтверждения: await confirmDialog({title, text, okLabel, danger}). */
  function confirmDialog({ title = 'Подтвердите действие', text = '', okLabel = 'Подтвердить', danger = false } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      modal({
        title: esc(title),
        body: `<p class="muted" style="margin:0">${esc(text)}</p>`,
        actions: [
          { label: 'Отмена', cls: 'btn-ghost', onClick: () => done(false) },
          { label: okLabel, cls: danger ? 'btn-danger' : 'btn-primary', onClick: () => done(true) },
        ],
      });
      // модалка закрыта (Esc, клик мимо, «Отмена») — считаем это отказом
      const observer = new MutationObserver(() => {
        if (!document.getElementById('modal-wrap')) { done(false); observer.disconnect(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 120000);
    });
  }

  /* ---------------------------- drawer ---------------------------- */
  function closeDrawer() {
    document.querySelectorAll('.drawer-wrap').forEach((d) => d.remove());
    document.querySelectorAll('.scrim').forEach((s) => s.remove());
    document.body.style.overflow = '';
  }

  /**
   * drawer({ title, subtitle, head, body, foot, wide })
   * body/head/foot — HTML-строки. Возвращает контейнер.
   */
  function drawer({ title = '', subtitle = '', head = '', body = '', foot = '', wide = false, onClose } = {}) {
    closeDrawer();
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const wrap = document.createElement('div');
    wrap.className = 'drawer-wrap';
    wrap.innerHTML = `
      <div class="drawer ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <div class="grow">
            <h3>${title}</h3>
            ${subtitle ? `<div class="small muted">${subtitle}</div>` : ''}
          </div>
          ${head}
          <button class="icon-btn" data-close aria-label="Закрыть">✕</button>
        </div>
        <div class="drawer-body">${body}</div>
        ${foot ? `<div class="drawer-foot">${foot}</div>` : ''}
      </div>`;
    document.body.append(scrim, wrap);
    document.body.style.overflow = 'hidden';
    scrim.onclick = () => { closeDrawer(); onClose && onClose(); };
    wrap.querySelector('[data-close]').onclick = () => { closeDrawer(); onClose && onClose(); };
    document.addEventListener('keydown', escClose);
    return wrap;
  }

  /* ---------------------------- меню ---------------------------- */
  function closeMenus() {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-menu-for]')) closeMenus();
  });

  /* ------------------- вкладки в шапке: переключение вида -------------------
     Кнопки <button data-view="..."> в панелях сборщика и кабинете клиента.
     Меняем хеш — срабатывает hashRouter страницы, поэтому работают и
     кнопки «назад/вперёд», и ссылка вида /assembler#/stock. */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#nav [data-view]');
    if (!btn) return;
    e.preventDefault();
    const view = btn.dataset.view;
    if (!view) return;
    if (location.hash === `#/${view}`) return;
    location.hash = `#/${view}`;
  });

  /* ---------------------------- кнопки: спиннер ---------------------------- */
  /** Выполнить async-действие с индикацией на кнопке. */
  async function withBusy(btn, fn) {
    if (!btn) return fn();
    const was = btn.classList.contains('is-loading');
    if (was) return undefined;
    btn.classList.add('is-loading');
    btn.disabled = true;
    try {
      return await fn();
    } finally {
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }
  }

  /** Копирование в буфер обмена с запасным вариантом для старых браузеров. */
  async function copy(text, label = 'Скопировано') {
    try {
      await navigator.clipboard.writeText(text);
      toast(label, 'ok', 2200);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? label : `Скопируйте вручную: ${text}`, ok ? 'ok' : 'warn');
      return ok;
    }
  }

  /* ---------------------------- метаданные ---------------------------- */
  let META = null;
  async function meta(force = false) {
    if (!META || force) META = await api('/api/meta');
    return META;
  }

  const statusInfo = (m, id) =>
    (m.statuses.find((s) => s.id === id)) || { id, label: id, color: '#64748B' };

  const badge = (status, m) => {
    const s = statusInfo(m, status);
    return `<span class="badge" style="background:${s.color}1f;color:${s.color};border-color:${s.color}4d">${esc(s.label)}</span>`;
  };

  const PAY_COLORS = {
    unpaid: '#94A3B8', pending: '#F59E0B', paid: '#16A34A', on_delivery: '#0EA5E9', refunded: '#EF4444',
  };
  const payBadge = (st, map) => {
    const c = PAY_COLORS[st] || '#94A3B8';
    const label = (map && map[st]) || st || '—';
    return `<span class="badge" style="background:${c}1f;color:${c};border-color:${c}4d">${esc(label)}</span>`;
  };

  /* ---------------------------- состояния ---------------------------- */
  const empty = (icon, title, text = '', action = '') => `
    <div class="empty">
      <div class="e-icon">${icon}</div>
      <h3>${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ''}
      ${action}
    </div>`;

  const skeletonCards = (n = 3) =>
    `<div class="grid grid-2">${Array.from({ length: n }, () => '<div class="skeleton sk-card"></div>').join('')}</div>`;

  const skeletonRows = (n = 5) =>
    `<div>${Array.from({ length: n }, () => '<div class="skeleton sk-row"></div>').join('')}</div>`;

  const skeletonKanban = () => `<div class="kanban">${
    Array.from({ length: 4 }, () => '<div class="kcol"><div class="skeleton sk-line" style="width:60%"></div><div class="skeleton sk-card" style="height:76px"></div><div class="skeleton sk-card" style="height:76px"></div></div>').join('')
  }</div>`;

  /* ---------------------------- хеш-роутер ---------------------------- */
  /**
   * hashRouter({ routes: {orders: renderOrders}, onChange })
   * Меняет вид без перезагрузки и сохраняет состояние в адресе — можно дать ссылку.
   */
  function hashRouter({ routes, onChange, fallback }) {
    const parse = () => {
      const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
      return raw || fallback || Object.keys(routes)[0];
    };
    let current = null;
    const apply = () => {
      const view = parse();
      if (view === current) return;
      current = view;
      const fn = routes[view];
      if (fn) fn();
      if (onChange) onChange(view);
    };
    window.addEventListener('hashchange', apply);
    return {
      get current() { return current; },
      go(view, replace = false) {
        if (replace) location.replace(`#/${view}`);
        else location.hash = `#/${view}`;
        if (view === current) apply();
      },
      refresh() { current = null; apply(); },
    };
  }

  /* ---------------------------- мелочи ---------------------------- */
  /** Значения объекта как <option> для <select>. */
  const options = (map, selected) => Object.entries(map || {})
    .map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(selected) ? 'selected' : ''}>${esc(v)}</option>`)
    .join('');

  /** Печатные документы по заказу. */
  const printDoc = (orderId, doc) => window.open(`/print/${orderId}?doc=${doc}`, '_blank');

  const trackLink = (track) => `${location.origin}/track/${encodeURIComponent(track)}`;

  /**
   * Поиск с перерисовкой страницы теряет фокус — возвращаем его и ставим курсор в конец.
   * Без этого невозможно набрать больше одного символа.
   */
  function keepSearchFocus() {
    const el = document.querySelector('[data-search-input]');
    if (!el || document.activeElement === el) return;
    const pos = el.value.length;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch { /* не текстовое поле */ }
  }

  theme.init();

  return {
    esc, n2, money, moneyShort, num, date, dateShort, ago, plural, debounce, val,
    theme, toggleTheme: () => theme.toggle(),
    api, toast, modal, closeModal, confirmDialog, drawer, closeDrawer, closeMenus,
    withBusy, copy, meta, statusInfo, badge, payBadge, empty, options,
    skeletonCards, skeletonRows, skeletonKanban, hashRouter, keepSearchFocus,
    printDoc, trackLink,
  };
})();

/** Общие мелочи для всех страниц: подсказки в title, закрытие меню по Esc. */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  // Ctrl/Cmd+K — быстрый переход к поиску, если он есть на странице
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    const search = document.querySelector('[data-search-input]');
    if (search) { e.preventDefault(); search.focus(); search.select(); }
  }
  // Esc в поиске — очистить
  if (e.key === 'Escape' && document.activeElement && document.activeElement.hasAttribute('data-search-input')) {
    const el = document.activeElement;
    if (el.value) {
      e.preventDefault();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
});