'use strict';

// ---------- state & utils ----------
const state = { me: null, family: null, members: [], roles: [], items: [], tab: 'voting' };
const $app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('ru-RU') + ' ₸';
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const member = (id) => state.members.find((m) => m.id === id);
const COLORS = ['#0f766e', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#059669', '#dc2626', '#4f46e5'];

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка сети');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2800);
}

function avatar(m, size = '') {
  if (!m) return `<div class="avatar ${size}">?</div>`;
  if (m.hasAvatar) return `<img class="avatar ${size}" src="/api/avatar/${m.id}" alt="${esc(m.name)}" loading="lazy">`;
  const initials = m.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<div class="avatar ${size}" style="background:${COLORS[m.id % COLORS.length]}">${esc(initials)}</div>`;
}

function roleLine(m) {
  if (!m) return '';
  const rel = m.relationTo ? member(m.relationTo) : null;
  return esc(m.role) + (rel ? ` · для ${esc(rel.name)}` : '');
}

const STATUS = {
  voting: { label: 'Голосование', cls: 'badge-voting', icon: '🗳️' },
  funding: { label: 'Идёт сбор', cls: 'badge-funding', icon: '💰' },
  done: { label: 'Собрано', cls: 'badge-done', icon: '✅' },
  rejected: { label: 'Отклонено', cls: 'badge-rejected', icon: '✖️' },
};
const badge = (s) => `<span class="badge ${STATUS[s].cls}">${STATUS[s].icon} ${STATUS[s].label}</span>`;

// Уменьшаем картинку на клиенте, чтобы не гонять мегабайты
function resizeImage(file, max, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Выберите изображение'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.src = url;
  });
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- router ----------
async function loadMe() {
  try {
    const d = await api('/me');
    state.me = d.user;
    state.family = d.family;
    state.members = d.members;
    return true;
  } catch {
    state.me = null;
    return false;
  }
}

async function route() {
  const hash = location.hash.slice(1) || '/';
  const [, page, id] = hash.split('/');
  if (!state.roles.length) state.roles = await api('/roles').catch(() => []);

  if (page === 'login' || page === 'register' || page === 'join') {
    if (await loadMe()) return go('/');
    return page === 'login' ? renderLogin() : renderRegister(page === 'join' ? id : '');
  }
  if (!state.me && !(await loadMe())) return go('/login');

  window.scrollTo(0, 0);
  if (page === 'new') return renderNew();
  if (page === 'item' && id) return renderItem(Number(id));
  if (page === 'family') return renderFamily();
  return renderHome();
}
const go = (p) => (location.hash = '#' + p);
window.addEventListener('hashchange', route);

function shell(content) {
  $app.innerHTML = `
    <header class="topbar"><div class="wrap">
      <a class="brand" href="#/"><div class="brand-mark">🏠</div><span>${esc(state.family.name)}</span></a>
      <div class="spacer"></div>
      <a href="#/family" title="Семья и профиль">${avatar(state.me)}</a>
    </div></header>
    <main><div class="wrap">${content}</div></main>`;
}

// ---------- auth pages ----------
function renderLogin() {
  $app.innerHTML = `
    <div class="auth-shell"><div class="auth-card">
      <div class="auth-head"><div class="brand-mark">🏠</div><h1>Отбасы Қоры</h1>
        <p class="muted">Семья решает вместе — и вместе собирает</p></div>
      <form class="card card-pad" id="f">
        <div id="err"></div>
        <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label>Пароль</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary btn-block">Войти</button>
        <p class="muted small" style="text-align:center;margin:16px 0 0">Нет аккаунта? <a href="#/register">Зарегистрироваться</a></p>
      </form>
    </div></div>`;
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: formData(f) });
      await loadMe();
      go('/');
    } catch (er) {
      document.getElementById('err').innerHTML = `<div class="error-box">${esc(er.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
}

function renderRegister(code = '') {
  let mode = code ? 'join' : 'create';
  let avatarData = null;
  let preview = null;
  const roleOpts = state.roles.map((r) => `<option>${esc(r)}</option>`).join('');

  $app.innerHTML = `
    <div class="auth-shell"><div class="auth-card">
      <div class="auth-head"><div class="brand-mark">🏠</div><h1>Регистрация</h1>
        <p class="muted">Создайте семью или присоединитесь по коду</p></div>
      <form class="card card-pad" id="f">
        <div class="segmented">
          <button type="button" data-mode="create">Новая семья</button>
          <button type="button" data-mode="join">Есть код семьи</button>
        </div>
        <div id="err"></div>

        <div class="avatar-picker">
          <div id="av" class="avatar">📷</div>
          <label class="file-label btn btn-ghost btn-sm">Загрузить аватар<input type="file" accept="image/*" id="avFile"></label>
        </div>

        <div class="field"><label>Ваше имя</label><input class="input" name="name" required maxlength="60" placeholder="Например, Ерлан"></div>

        <div id="createBox" class="field"><label>Название семьи</label>
          <input class="input" name="familyName" maxlength="60" placeholder="Семья Ахметовых"></div>

        <div id="joinBox">
          <div class="field"><label>Код семьи</label>
            <input class="input" name="inviteCode" id="code" value="${esc(code)}" placeholder="Например, 4F9A2C1B" style="text-transform:uppercase">
            <span class="hint" id="famHint">Код можно узнать у любого члена семьи</span></div>
        </div>

        <div class="field"><label>Кто вы в семье</label>
          <select class="input" name="role" required><option value="">— выберите —</option>${roleOpts}</select></div>

        <div class="field" id="relBox"><label>Кому вы приходитесь <span class="muted">(необязательно)</span></label>
          <select class="input" name="relationTo" id="rel"><option value="">—</option></select>
          <span class="hint">Например: келін → для кого; братишка → чей</span></div>

        <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label>Пароль</label><input class="input" name="password" type="password" minlength="6" autocomplete="new-password" required>
          <span class="hint">Не короче 6 символов</span></div>
        <button class="btn btn-primary btn-block">Зарегистрироваться</button>
        <p class="muted small" style="text-align:center;margin:16px 0 0">Уже есть аккаунт? <a href="#/login">Войти</a></p>
      </form>
    </div></div>`;

  const f = document.getElementById('f');
  const setMode = (m) => {
    mode = m;
    f.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    document.getElementById('createBox').classList.toggle('hidden', m !== 'create');
    document.getElementById('joinBox').classList.toggle('hidden', m !== 'join');
    document.getElementById('relBox').classList.toggle('hidden', m !== 'join' || !preview);
  };
  f.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  const codeInput = document.getElementById('code');
  let t;
  const lookup = async () => {
    const v = codeInput.value.trim();
    const hint = document.getElementById('famHint');
    preview = null;
    if (v.length < 4) {
      hint.textContent = 'Код можно узнать у любого члена семьи';
      return setMode(mode);
    }
    try {
      preview = await api('/family-preview?code=' + encodeURIComponent(v));
      hint.innerHTML = `✅ Семья «${esc(preview.name)}», участников: ${preview.members.length}`;
      document.getElementById('rel').innerHTML =
        '<option value="">—</option>' + preview.members.map((m) => `<option value="${m.id}">${esc(m.name)} (${esc(m.role)})</option>`).join('');
    } catch (e) {
      hint.textContent = '❌ ' + e.message;
    }
    setMode(mode);
  };
  codeInput.oninput = () => { clearTimeout(t); t = setTimeout(lookup, 350); };
  if (code) lookup();
  setMode(mode);

  document.getElementById('avFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      avatarData = await resizeImage(file, 320);
      document.getElementById('av').outerHTML = `<img id="av" class="avatar" src="${avatarData}" alt="">`;
    } catch (er) { toast(er.message, true); }
  };

  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    const btn = f.querySelector('button[type=submit], button:not([type])');
    btn.disabled = true;
    try {
      await api('/register', { method: 'POST', body: { ...d, familyMode: mode, avatar: avatarData } });
      await loadMe();
      toast('Добро пожаловать, ' + state.me.name + '!');
      go(mode === 'create' ? '/family' : '/');
    } catch (er) {
      document.getElementById('err').innerHTML = `<div class="error-box">${esc(er.message)}</div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- home ----------
async function renderHome() {
  shell('<div class="spinner"></div>');
  try {
    state.items = await api('/items');
  } catch (e) {
    return toast(e.message, true);
  }
  const counts = { voting: 0, funding: 0, done: 0, rejected: 0 };
  state.items.forEach((i) => counts[i.status]++);
  const needMyVote = state.items.filter((i) => i.status === 'voting' && i.creatorId !== state.me.id && i.myVote === null).length;
  const tabs = ['voting', 'funding', 'done', 'rejected'];
  const list = state.items.filter((i) => i.status === state.tab);

  shell(`
    <div class="family-head">
      <div class="grow">
        <h1>Привет, ${esc(state.me.name)} 👋</h1>
        <p class="muted" style="margin:4px 0 0">${needMyVote ? `Ждут вашего голоса: <b>${needMyVote}</b>` : 'Что купим вместе?'}</p>
      </div>
      <a class="stack" href="#/family" title="Семья">${state.members.slice(0, 6).map((m) => avatar(m)).join('')}</a>
    </div>
    ${state.members.length < 2 ? `<div class="note" style="margin-bottom:16px">Вы пока один в семье. <a href="#/family">Пригласите родных</a> — без них голосование не начнётся.</div>` : ''}
    <div class="tabs">${tabs.map((t) => `<button class="tab ${t === state.tab ? 'active' : ''}" data-tab="${t}">${STATUS[t].icon} ${STATUS[t].label}<span class="count">${counts[t]}</span></button>`).join('')}</div>
    ${list.length ? `<div class="grid">${list.map(itemCard).join('')}</div>` : `
      <div class="empty"><div class="big">${STATUS[state.tab].icon}</div>
      ${state.tab === 'voting' ? 'Пока никто ничего не предложил.<br>Нажмите «Хочу вещь», чтобы начать.' : 'Здесь пока пусто'}</div>`}
    <button class="fab" onclick="location.hash='#/new'"><span style="font-size:22px">＋</span> Хочу вещь</button>`);

  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderHome(); }));
}

function itemCard(i) {
  const author = member(i.creatorId);
  let extra = '';
  if (i.status === 'voting') {
    const mine = i.creatorId === state.me.id;
    extra = `<div class="money-row"><span>За: <b class="vote-yes">${i.yes}</b> · Против: <b class="vote-no">${i.no}</b></span><span class="muted">из ${i.votersCount}</span></div>
      ${!mine && i.myVote === null ? '<div class="note small">Нужен ваш голос</div>' : ''}`;
  } else if (i.status === 'funding' || i.status === 'done') {
    extra = `<div class="progress"><div style="width:${pct(i.collected, i.price)}%"></div></div>
      <div class="money-row"><span>Собрано <b>${money(i.collected)}</b></span><span class="muted">${pct(i.collected, i.price)}%</span></div>
      ${i.status === 'funding' ? `<div class="money-row"><span class="muted">Осталось</span><b>${money(i.remaining)}</b></div>` : ''}`;
  }
  return `<a class="card item-card" href="#/item/${i.id}">
    <div class="item-photo">${i.hasPhoto ? `<img src="/api/items/${i.id}/photo" alt="" loading="lazy">` : '<div class="ph">🎁</div>'}${badge(i.status)}</div>
    <div class="item-body">
      <h3>${esc(i.title)}</h3>
      <div class="price">${money(i.price)}</div>
      ${extra}
      <div class="item-meta">${avatar(author, 'sm')}<span>${esc(author?.name || '—')}</span></div>
    </div></a>`;
}

// ---------- new item ----------
function renderNew() {
  let photo = null;
  shell(`
    <a class="back" href="#/">← Назад</a>
    <div class="card card-pad" style="max-width:640px;margin:0 auto">
      <h1 style="margin-bottom:6px">Хочу вещь</h1>
      <p class="muted" style="margin:0 0 18px">Семья проголосует, и если все за — начнётся сбор денег.</p>
      <form id="f">
        <label class="photo-drop" id="drop"><input type="file" accept="image/*" id="ph"><span>📷<br>Добавить фото</span></label>
        <div style="height:14px"></div>
        <div class="field"><label>Что хотите купить</label><input class="input" name="title" required maxlength="100" placeholder="Например, велосипед"></div>
        <div class="field"><label>Описание <span class="muted">(зачем, ссылка на товар)</span></label><textarea class="input" name="description" maxlength="1000"></textarea></div>
        <div class="row">
          <div class="field"><label>Цена, ₸</label><input class="input" name="price" type="number" inputmode="numeric" min="1" step="1" required></div>
          <div class="field"><label>Уже есть своих, ₸</label><input class="input" name="ownAmount" type="number" inputmode="numeric" min="0" step="1" value="0"></div>
        </div>
        <div class="note" id="calc" style="margin-bottom:14px">Нужно собрать: 0 ₸</div>
        <button class="btn btn-primary btn-block">Отправить на голосование</button>
      </form>
    </div>`);
  const f = document.getElementById('f');
  const calc = () => {
    const d = formData(f);
    document.getElementById('calc').textContent = 'Нужно собрать: ' + money(Math.max(0, (+d.price || 0) - (+d.ownAmount || 0)));
  };
  f.oninput = calc;
  document.getElementById('ph').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      photo = await resizeImage(file, 1280);
      document.getElementById('drop').querySelector('span')?.remove();
      document.getElementById('drop').querySelector('img')?.remove();
      document.getElementById('drop').insertAdjacentHTML('beforeend', `<img src="${photo}" alt="">`);
    } catch (er) { toast(er.message, true); }
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    withBusy(f.querySelector('button'), async () => {
      const { id } = await api('/items', { method: 'POST', body: { ...formData(f), photo } });
      state.tab = 'voting';
      toast('Отправлено на голосование');
      go('/item/' + id);
    });
  };
}

// ---------- item page ----------
async function renderItem(id) {
  shell('<div class="spinner"></div>');
  let i;
  try {
    await loadMe();
    i = await api('/items/' + id);
  } catch (e) {
    toast(e.message, true);
    return go('/');
  }
  const author = member(i.creatorId);
  const isMine = i.creatorId === state.me.id;
  const voters = state.members.filter((m) => m.id !== i.creatorId);
  const voteOf = (uid) => i.votes.find((v) => v.userId === uid);

  let action = '';
  if (i.status === 'voting') {
    if (isMine) {
      action = `<div class="note">Это ваша заявка — ждём голосов семьи (${i.yes + i.no} из ${voters.length}).</div>`;
    } else {
      action = `<h3 style="margin-bottom:10px">Нужна ли эта вещь?</h3>
        <div class="vote-btns">
          <button class="btn ${i.myVote === true ? 'btn-ok' : 'btn-ghost'}" data-vote="1">👍 Нужна</button>
          <button class="btn ${i.myVote === false ? 'btn-no' : 'btn-ghost'}" data-vote="0">👎 Не нужна</button>
        </div>
        <p class="muted small" style="margin:8px 0 0">${i.myVote === null ? 'Сбор начнётся, когда все члены семьи одобрят.' : 'Голос можно изменить, пока голосуют остальные.'}</p>`;
    }
  } else if (i.status === 'funding') {
    action = `<h3 style="margin-bottom:10px">Внести деньги</h3>
      <form id="cf">
        <div class="field"><input class="input" name="amount" type="number" inputmode="numeric" min="1" max="${i.remaining}" step="1" placeholder="Сумма, ₸ (макс. ${money(i.remaining)})" required></div>
        <div class="field"><input class="input" name="comment" maxlength="200" placeholder="Комментарий (необязательно)"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          ${[1000, 5000, 10000].filter((v) => v < i.remaining).map((v) => `<button type="button" class="btn btn-ghost btn-sm" data-q="${v}">${money(v)}</button>`).join('')}
          <button type="button" class="btn btn-ghost btn-sm" data-q="${i.remaining}">Всё: ${money(i.remaining)}</button>
        </div>
        <button class="btn btn-primary btn-block">💸 Пожертвовать</button>
      </form>`;
  } else if (i.status === 'done') {
    action = `<div class="note" style="background:var(--ok-soft);color:var(--ok)">🎉 Деньги собраны! Можно покупать.</div>`;
  } else {
    action = `<div class="note" style="background:var(--no-soft);color:var(--no)">Семья решила, что эта вещь пока не нужна.</div>`;
  }

  const showMoney = i.status === 'funding' || i.status === 'done';
  shell(`
    <a class="back" href="#/">← Все вещи</a>
    <div class="detail">
      <div>
        <div class="detail-photo">${i.hasPhoto ? `<img src="/api/items/${i.id}/photo" alt="">` : '<div class="ph">🎁</div>'}</div>
        ${i.description ? `<div class="card card-pad section"><h3 style="margin-bottom:6px">Описание</h3><p style="margin:0;white-space:pre-wrap">${esc(i.description)}</p></div>` : ''}
      </div>
      <div>
        <div class="card card-pad">
          ${badge(i.status)}
          <h1 style="margin:10px 0 4px">${esc(i.title)}</h1>
          <div class="item-meta">${avatar(author, 'sm')}<span>${esc(author?.name || '—')} · ${esc(author?.role || '')}</span></div>
          <div class="stats">
            <div class="stat"><div class="label">Цена</div><div class="val">${money(i.price)}</div></div>
            <div class="stat"><div class="label">Собрано</div><div class="val">${money(i.collected)}</div></div>
            <div class="stat"><div class="label">Осталось</div><div class="val">${money(i.remaining)}</div></div>
          </div>
          ${showMoney ? `<div class="progress"><div style="width:${pct(i.collected, i.price)}%"></div></div>
            <p class="muted small" style="margin:6px 0 16px">${pct(i.collected, i.price)}% · своих у автора ${money(i.ownAmount)}</p>` : ''}
          ${action}
          ${isMine && i.contributed === 0 ? `<button class="btn btn-ghost btn-sm" id="del" style="margin-top:14px">Удалить заявку</button>` : ''}
        </div>

        <div class="card card-pad section">
          <h3>Голоса семьи</h3>
          <div class="list">${voters.length ? voters.map((m) => {
            const v = voteOf(m.id);
            const st = v ? (v.approve ? '<span class="vote-yes">👍 За</span>' : '<span class="vote-no">👎 Против</span>') : '<span class="vote-wait">⏳ Ждём</span>';
            return `<div class="list-row">${avatar(m)}<div class="grow"><div class="name">${esc(m.name)}</div><div class="muted small">${roleLine(m)}</div></div>${st}</div>`;
          }).join('') : '<p class="muted">В семье пока больше никого нет</p>'}</div>
        </div>

        ${showMoney ? `<div class="card card-pad section">
          <h3>Кто сколько внёс</h3>
          <div class="list">${i.contributions.length ? i.contributions.map((c) => {
            const m = member(c.userId);
            return `<div class="list-row">${avatar(m)}<div class="grow"><div class="name">${esc(m?.name || '—')}</div>${c.comment ? `<div class="muted small">${esc(c.comment)}</div>` : ''}</div><b>${money(c.amount)}</b></div>`;
          }).join('') : '<p class="muted">Пока никто не внёс — будьте первым!</p>'}</div>
        </div>` : ''}
      </div>
    </div>`);

  document.querySelectorAll('[data-vote]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    await api(`/items/${id}/vote`, { method: 'POST', body: { approve: b.dataset.vote === '1' } });
    toast('Голос учтён');
    renderItem(id);
  })));

  const cf = document.getElementById('cf');
  if (cf) {
    cf.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => (cf.amount.value = b.dataset.q)));
    cf.onsubmit = (e) => {
      e.preventDefault();
      withBusy(cf.querySelector('button:not([type=button])'), async () => {
        await api(`/items/${id}/contribute`, { method: 'POST', body: formData(cf) });
        toast('Спасибо! Взнос добавлен 💚');
        renderItem(id);
      });
    };
  }

  const del = document.getElementById('del');
  if (del) {
    let armed = false;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Точно удалить? Нажмите ещё раз';
        del.classList.add('btn-no');
        return;
      }
      withBusy(del, async () => {
        await api('/items/' + id, { method: 'DELETE' });
        toast('Заявка удалена');
        go('/');
      });
    };
  }
}

// ---------- family & profile ----------
async function renderFamily() {
  await loadMe();
  let avatarData;
  const link = `${location.origin}/#/join/${state.family.inviteCode}`;
  const roleOpts = state.roles.map((r) => `<option ${r === state.me.role ? 'selected' : ''}>${esc(r)}</option>`).join('');
  const relOpts = state.members.filter((m) => m.id !== state.me.id)
    .map((m) => `<option value="${m.id}" ${m.id === state.me.relationTo ? 'selected' : ''}>${esc(m.name)} (${esc(m.role)})</option>`).join('');

  shell(`
    <a class="back" href="#/">← Назад</a>
    <div class="detail">
      <div>
        <div class="card card-pad">
          <h2 style="margin-bottom:12px">Пригласить в семью</h2>
          <div class="invite">
            <div style="flex:1;min-width:160px"><div class="muted small">Код семьи</div><code>${esc(state.family.inviteCode)}</code></div>
            <button class="btn btn-primary" id="share">Поделиться ссылкой</button>
          </div>
          <p class="muted small" style="margin:10px 0 0">Отправьте ссылку в WhatsApp или Telegram — по ней сразу откроется регистрация в вашу семью.</p>
        </div>
        <div class="card card-pad section">
          <h2 style="margin-bottom:6px">Семья «${esc(state.family.name)}»</h2>
          <div class="list">${state.members.map((m) => `
            <div class="list-row">${avatar(m)}<div class="grow"><div class="name">${esc(m.name)}${m.id === state.me.id ? ' <span class="muted small">(вы)</span>' : ''}</div><div class="muted small">${roleLine(m)}</div></div></div>`).join('')}</div>
        </div>
      </div>
      <div>
        <form class="card card-pad" id="pf">
          <h2 style="margin-bottom:14px">Мой профиль</h2>
          <div class="avatar-picker">
            <span id="av">${avatar(state.me, 'lg')}</span>
            <label class="file-label btn btn-ghost btn-sm">Сменить фото<input type="file" accept="image/*" id="avFile"></label>
          </div>
          <div class="field"><label>Имя</label><input class="input" name="name" value="${esc(state.me.name)}" required maxlength="60"></div>
          <div class="field"><label>Кто вы в семье</label><select class="input" name="role">${roleOpts}</select></div>
          <div class="field"><label>Кому вы приходитесь</label><select class="input" name="relationTo"><option value="">—</option>${relOpts}</select></div>
          <button class="btn btn-primary btn-block">Сохранить</button>
          <button type="button" class="btn btn-ghost btn-block" id="logout" style="margin-top:10px">Выйти</button>
        </form>
      </div>
    </div>`);

  document.getElementById('share').onclick = async () => {
    const text = `Присоединяйся к нашей семье «${state.family.name}»: ${link}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Отбасы Қоры', text, url: link }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch { toast(link); }
    }
  };
  document.getElementById('avFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      avatarData = await resizeImage(file, 320);
      document.getElementById('av').innerHTML = `<img class="avatar lg" src="${avatarData}" alt="">`;
    } catch (er) { toast(er.message, true); }
  };
  const pf = document.getElementById('pf');
  pf.onsubmit = (e) => {
    e.preventDefault();
    withBusy(pf.querySelector('button:not([type=button])'), async () => {
      const body = formData(pf);
      if (avatarData) body.avatar = avatarData;
      await api('/me', { method: 'PUT', body });
      toast('Профиль сохранён');
      renderFamily();
    });
  };
  document.getElementById('logout').onclick = async () => {
    await api('/logout', { method: 'POST' });
    state.me = null;
    go('/login');
  };
}

route();
