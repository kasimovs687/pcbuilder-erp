/* ============================================================================
   Публичная страница отслеживания: /track и /track/<трек-номер>
   Без входа: по трек-номеру показываем путь посылки и принимаем код получения.
   ========================================================================== */
const { esc, money, date, ago, api, toast, meta, empty, copy } = PCB;

const elInput = document.getElementById('track-input');
const elResult = document.getElementById('track-result');
const elHint = document.getElementById('track-hint');
const elForm = document.getElementById('track-form');

let META = null;
let lastNumber = '';

const shipLabel = (m, s) => (m.shipmentStatuses && m.shipmentStatuses[s]) || s;
const orderStatus = (m, s) => (m.statuses || []).find((x) => x.id === s) || { id: s, label: s, color: '#64748B' };
const shipmentFlow = () => (META && META.shipmentFlow) || [
  'created', 'packing', 'in_transit', 'sorting', 'out_for_delivery', 'arrived', 'delivered',
];

function statusBadge(s) {
  const st = orderStatus(META, s);
  return `<span class="badge badge-lg" style="background:${st.color}1f;color:${st.color};border-color:${st.color}4d">${esc(st.label)}</span>`;
}

/** Ступени доставки: пройденные подсвечиваются, текущая выделяется. */
function stageBar(current) {
  const flow = shipmentFlow();
  const idx = flow.indexOf(current);
  const done = idx === -1 ? flow.length : idx;
  const failed = current === 'returned';
  return `<div class="stepper">${flow.map((s, i) => {
    const cls = failed ? '' : i < done ? 'done' : i === done ? 'now' : '';
    return `<div class="step ${cls}">
      <span class="dot">${!failed && i < done ? '✓' : ''}</span>
      <span class="step-label">${esc(shipLabel(META, s))}</span>
    </div>`;
  }).join('')}</div>`;
}

function timelineHtml(events) {
  if (!events || !events.length) {
    return '<div class="small muted">Событий пока нет — отправление скоро появится в системе.</div>';
  }
  return `<ul class="timeline">${events.map((e) => `
    <li class="${e.status === 'delivered' ? 'ok' : e.status === 'returned' ? 'danger' : ''}">
      <b>${esc(shipLabel(META, e.status))}</b>
      <span>${esc([e.location, e.note].filter(Boolean).join(' · '))} · ${date(e.created_at)}</span>
    </li>`).join('')}</ul>`;
}

function confirmBlock(data) {
  const o = data.order || {};
  if (data.canConfirm) {
    return `
      <div class="block" style="border-color:color-mix(in srgb, var(--ok) 40%, transparent); background:var(--ok-soft)">
        <h4>🔑 Подтверждение получения</h4>
        <p class="small muted" style="margin:0">
          Проверьте комплектацию и внешний вид, затем введите 4-значный код из накладной.
          ${o.payment_status === 'on_delivery' ? `<b>К оплате курьеру: ${money(o.total)}</b>.` : ''}
        </p>
        <div class="row gap-8 mt-12 wrap-row">
          <input id="cf-code" class="code-input" placeholder="____" maxlength="4" inputmode="numeric" autocomplete="off" aria-label="Код подтверждения">
          <button class="btn btn-success btn-lg" id="cf-btn">Подтвердить получение</button>
        </div>
        <div class="xs muted mt-8">Подтверждая получение, вы закрываете заказ. Отменить действие нельзя.</div>
      </div>`;
  }
  if (o.status === 'delivered' || o.status === 'completed') {
    return `<div class="notice ok mt-16"><span class="n-icon">✅</span><span>Заказ получен — спасибо! Если что-то не так, напишите мастерской по телефону из накладной.</span></div>`;
  }
  return `<div class="notice warn mt-16"><span class="n-icon">⏳</span><span>Подтвердить получение можно, когда посылка будет у вас. Код появится в накладной.</span></div>`;
}

function render(data, number) {
  const o = data.order || {};
  const s = data.shipment || {};
  const track = s.track_number || number;

  elResult.innerHTML = `
    <div class="card">
      <div class="row-between wrap-row gap-12 mb-16">
        <div>
          <h2 style="margin:0">Отправление <span class="mono">${esc(track)}</span></h2>
          <div class="small muted">
            Заказ ${esc(o.order_no || '—')} · ${esc(s.carrier || '—')} · создан ${date(s.created_at)}
          </div>
        </div>
        <div class="row gap-8">${statusBadge(o.status || '')}</div>
      </div>

      ${stageBar(s.status)}

      <div class="grid grid-4 gap-8 mt-20">
        <div class="stat" style="--stat-accent:var(--info)">
          <div class="stat-icon">📅</div>
          <span class="stat-label">Ожидаем</span>
          <span class="stat-value" style="font-size:16px">${esc(s.eta || '—')}</span>
        </div>
        <div class="stat" style="--stat-accent:var(--brand)">
          <div class="stat-icon">📍</div>
          <span class="stat-label">Город</span>
          <span class="stat-value" style="font-size:16px">${esc(s.city || o.city || '—')}</span>
        </div>
        <div class="stat" style="--stat-accent:var(--warn)">
          <div class="stat-icon">⚖️</div>
          <span class="stat-label">Вес</span>
          <span class="stat-value" style="font-size:16px">${s.weight_kg ? s.weight_kg + ' кг' : '—'}</span>
        </div>
        <div class="stat" style="--stat-accent:var(--ok)">
          <div class="stat-icon">💰</div>
          <span class="stat-label">Доставка</span>
          <span class="stat-value" style="font-size:16px">${s.cost ? money(s.cost) : 'бесплатно'}</span>
        </div>
      </div>

      <div class="small muted mt-12">
        ${esc((META.deliveryTypes && META.deliveryTypes[o.delivery_type]) || o.delivery_type || '')}
        ${o.address ? ' · ' + esc(o.address) : ''}
      </div>

      <div class="row-between mt-20 mb-12">
        <h3 style="margin:0">История перемещения</h3>
        <button class="btn btn-sm" onclick="lookup('${esc(track)}')">🔄 Обновить</button>
      </div>
      ${timelineHtml(data.events)}

      <div class="row wrap-row gap-8 mt-16">
        <button class="btn btn-sm" onclick="copy(location.origin + '/track/' + encodeURIComponent('${esc(track)}'), 'Ссылка скопирована')">🔗 Скопировать ссылку</button>
        <button class="btn btn-sm" onclick="navigator.share ? navigator.share({title:'Мой заказ PCBuilder', url:location.href}) : copy(location.href,'Ссылка скопирована')">📤 Поделиться</button>
        <a class="btn btn-sm" href="/client">Войти в кабинет</a>
      </div>

      ${confirmBlock(data)}
    </div>`;

  const btn = document.getElementById('cf-btn');
  const input = document.getElementById('cf-code');
  if (btn && input) {
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 4); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    btn.onclick = async () => {
      const code = input.value.trim();
      if (code.length !== 4) return toast('Введите 4 цифры кода из накладной', 'warn');
      btn.disabled = true;
      btn.classList.add('is-loading');
      try {
        await api(`/api/track/${encodeURIComponent(track)}/confirm`, { method: 'POST', body: { code } });
        toast('Спасибо! Получение подтверждено', 'ok');
        await lookup(track);
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false;
        btn.classList.remove('is-loading');
        input.select();
      }
    };
    setTimeout(() => input.focus(), 120);
  }
}

async function lookup(number) {
  const value = String(number || '').trim();
  if (!value) {
    toast('Введите трек-номер', 'warn');
    elInput.focus();
    return;
  }
  lastNumber = value;
  elResult.innerHTML = '<div class="card"><div class="skeleton sk-line" style="width:40%"></div><div class="skeleton sk-line"></div><div class="skeleton sk-row"></div></div>';
  elHint.textContent = '';
  try {
    if (!META) META = await api('/api/meta');
    const data = await api('/api/track/' + encodeURIComponent(value));
    render(data, value);
    try { history.replaceState(null, '', '/track/' + encodeURIComponent(value)); } catch { /* noop */ }
  } catch (e) {
    elResult.innerHTML = `<div class="card">${empty('🔍', 'Отправление не найдено',
      `Проверьте трек-номер «${value}» — он указан в SMS, накладной и в кабинете клиента.`)}</div>`;
    elHint.textContent = 'Номер приходит в SMS после передачи заказа в службу доставки.';
  }
}

elForm.onsubmit = (e) => { e.preventDefault(); lookup(elInput.value); };

/* deep link: /track/TRxxxxxxx */
(async () => {
  const m = location.pathname.match(/^\/track\/(.+)$/);
  const fromPath = m && m[1] ? decodeURIComponent(m[1]).replace(/\/$/, '') : '';
  if (fromPath && fromPath !== 'index.html') {
    elInput.value = fromPath;
    await lookup(fromPath);
    return;
  }
  elInput.focus();
})();