'use strict';

// ---------- state & utils ----------
const state = { me: null, family: null, members: [], roles: [], items: [], tab: 'voting' };
const $app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('ru-RU') + ' ₸';
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const member = (id) => state.members.find((m) => m.id === id);
// версия из ?v= в адресе этого скрипта; сервер шлёт свою в X-App-Version
const APP_VERSION = new URL(document.currentScript.src).searchParams.get('v');
const COLORS = ['#0f766e', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#059669', '#dc2626', '#4f46e5'];

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const serverVersion = res.headers.get('X-App-Version');
  // сайт обновился, пока страница была открыта — перезагружаемся (только на чтении, чтобы не потерять отправку)
  if (APP_VERSION && serverVersion && serverVersion !== APP_VERSION && !opts.method) {
    location.reload();
    return new Promise(() => {});
  }
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

// Чек: фото сжимаем, PDF берём как есть
function readReceipt(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 4 * 1024 * 1024) return Promise.reject(new Error('PDF больше 4 МБ'));
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Не удалось прочитать файл'));
      r.readAsDataURL(file);
    });
  }
  return resizeImage(file, 1600, 0.85);
}

// Публичной ссылки «перевод на номер» у Kaspi нет — открываем само приложение.
// Android: запуск по имени пакета, без приложения — Google Play. iPhone: App Store с кнопкой «Открыть».
const KASPI_PLAY = 'https://play.google.com/store/apps/details?id=kz.kaspi.mobile';
function kaspiAppLink() {
  if (/android/i.test(navigator.userAgent)) {
    return 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=kz.kaspi.mobile;' +
      `S.browser_fallback_url=${encodeURIComponent(KASPI_PLAY)};end`;
  }
  if (isIOS()) return 'https://apps.apple.com/kz/app/id1195076505';
  return null;
}

const itemUrl = (id) => `${location.origin}/#/item/${id}`;

// Готовый текст для семейной группы в WhatsApp
function waText(i) {
  const author = member(i.creatorId)?.name || '';
  if (i.status === 'voting') {
    return `🗳️ ${author} хочет купить «${i.title}» за ${money(i.price)}.\nНужна ли эта вещь? Проголосуйте:\n${itemUrl(i.id)}`;
  }
  if (i.status === 'funding') {
    return `💰 Сбор на «${i.title}»: собрано ${money(i.collected)} из ${money(i.price)}, осталось ${money(i.remaining)}.\n` +
      `Kaspi: ${i.kaspiPhone}${i.kaspiName ? ` (${i.kaspiName})` : ''}\nПомочь и прикрепить чек:\n${itemUrl(i.id)}`;
  }
  if (i.status === 'done') return `🎉 Собрали на «${i.title}» — ${money(i.price)}! Спасибо всем 💚\n${itemUrl(i.id)}`;
  return `«${i.title}» — семья решила пока не покупать.\n${itemUrl(i.id)}`;
}
const waLink = (i) => 'https://wa.me/?text=' + encodeURIComponent(waText(i));

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

// ---------- установка как приложение (PWA) ----------
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canOfferInstall = () => !isStandalone() && (installPrompt || isIOS());
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelectorAll('[data-install-slot]').forEach((el) => (el.innerHTML = installBox(el.dataset.installSlot)));
  bindInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.querySelectorAll('[data-install-slot]').forEach((el) => (el.innerHTML = ''));
  toast('Приложение установлено 🎉');
});

function installBox(where) {
  if (!canOfferInstall()) return '';
  if (where === 'home' && store.get('installDismissed')) return '';
  const body = installPrompt
    ? '<button class="btn btn-primary btn-sm" data-install>📲 Установить</button>'
    : '<div class="small">Нажмите <b>«Поделиться»</b> <span class="ios-share">⬆︎</span> внизу Safari → <b>«На экран „Домой“»</b> → <b>«Добавить»</b>.</div>';
  return `<div class="install-card">
    <img src="/icons/icon-192.png" alt="" width="44" height="44">
    <div class="grow"><b>Установить как приложение</b>
      <div class="muted small">Иконка на главном экране, открывается без браузера</div>
      <div style="margin-top:8px">${body}</div></div>
    ${where === 'home' ? '<button class="icon-btn" data-install-close title="Скрыть">✕</button>' : ''}
  </div>`;
}

function bindInstall() {
  document.querySelectorAll('[data-install]').forEach((b) => (b.onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
  }));
  document.querySelectorAll('[data-install-close]').forEach((b) => (b.onclick = () => {
    store.set('installDismissed', '1');
    b.closest('[data-install-slot]').innerHTML = '';
  }));
}

// ---------- push-уведомления ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// на iPhone push работает только в приложении, установленном на экран «Домой»
const pushNeedsInstall = () => isIOS() && !isStandalone();

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(perm === 'denied'
      ? 'Уведомления запрещены в настройках браузера — разрешите их для этого сайта'
      : 'Разрешение не выдано');
  }
  const { key } = await api('/push/key');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

// Привязываем подписку этого устройства к текущему аккаунту (после входа под другим пользователем)
let pushSynced = false;
async function syncPush() {
  if (pushSynced || !pushSupported() || Notification.permission !== 'granted') return;
  pushSynced = true;
  try {
    const sub = await currentSub();
    if (sub) await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch {}
}

async function pushBox(where) {
  if (pushNeedsInstall()) {
    return where === 'profile'
      ? `<div class="install-card"><div class="push-ico">🔔</div><div class="grow"><b>Уведомления на телефон</b>
          <div class="muted small">На iPhone уведомления работают только в установленном приложении: установите его (см. выше) и откройте с экрана «Домой».</div></div></div>`
      : '';
  }
  if (!pushSupported()) {
    return where === 'profile'
      ? '<div class="install-card"><div class="push-ico">🔕</div><div class="grow"><b>Уведомления на телефон</b><div class="muted small">Этот браузер не поддерживает уведомления. Откройте сайт в Chrome или установите приложение.</div></div></div>'
      : '';
  }
  const sub = await currentSub().catch(() => null);
  const on = !!sub && Notification.permission === 'granted';
  if (where === 'home' && (on || Notification.permission === 'denied' || store.get('pushDismissed'))) return '';
  if (where === 'home') {
    return `<div class="install-card"><div class="push-ico">🔔</div>
      <div class="grow"><b>Включите уведомления</b>
        <div class="muted small">Узнавайте сразу о новых вещах, голосах и переводах</div>
        <div style="margin-top:8px"><button class="btn btn-primary btn-sm" data-push-on>Включить</button></div></div>
      <button class="icon-btn" data-push-close title="Скрыть">✕</button></div>`;
  }
  return `<div class="install-card"><div class="push-ico">${on ? '🔔' : '🔕'}</div>
    <div class="grow"><b>Уведомления на телефон: ${on ? 'включены' : 'выключены'}</b>
      <div class="muted small">${Notification.permission === 'denied'
        ? 'Запрещены в настройках браузера. Разрешите уведомления для этого сайта и обновите страницу.'
        : 'Новые вещи, голоса, начало сбора, переводы и их проверка.'}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${on
        ? '<button class="btn btn-ghost btn-sm" data-push-test>Проверить</button><button class="btn btn-ghost btn-sm" data-push-off>Выключить</button>'
        : Notification.permission === 'denied' ? '' : '<button class="btn btn-primary btn-sm" data-push-on>Включить</button>'}</div>
    </div></div>`;
}

async function fillPush() {
  for (const el of document.querySelectorAll('[data-push-slot]')) {
    el.innerHTML = await pushBox(el.dataset.pushSlot);
  }
  document.querySelectorAll('[data-push-on]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    await enablePush();
    toast('Уведомления включены 🔔');
    fillPush();
  })));
  document.querySelectorAll('[data-push-off]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    await disablePush();
    toast('Уведомления выключены');
    fillPush();
  })));
  document.querySelectorAll('[data-push-test]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const r = await api('/push/test', { method: 'POST' });
    toast(r.sent ? 'Отправлено — уведомление придёт через пару секунд' : 'Не удалось доставить — выключите и включите уведомления снова', !r.sent);
  })));
  document.querySelectorAll('[data-push-close]').forEach((b) => (b.onclick = () => {
    store.set('pushDismissed', '1');
    b.closest('[data-push-slot]').innerHTML = '';
  }));
}

// ---------- router ----------
async function loadMe() {
  try {
    const d = await api('/me');
    state.me = d.user;
    state.family = d.family;
    state.members = d.members;
    state.mailEnabled = d.mailEnabled;
    syncPush();
    return true;
  } catch {
    state.me = null;
    return false;
  }
}

async function route() {
  const [hash, query] = (location.hash.slice(1) || '/').split('?');
  const [, page, id] = hash.split('/');
  clearInterval(state.chatTimer);
  if (!state.roles.length) state.roles = await api('/roles').catch(() => []);

  if (page === 'login' || page === 'register' || page === 'join') {
    if (await loadMe()) return go('/');
    return page === 'login' ? renderLogin() : renderRegister(page === 'join' ? id : '');
  }
  if (!state.me && !(await loadMe())) return go('/login');

  window.scrollTo(0, 0);
  if (page === 'new') return renderNew();
  if (page === 'item' && id) return renderItem(Number(id), { chat: query === 'chat' });
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
  const needMyCheck = state.items.filter((i) => i.creatorId === state.me.id && i.pendingCount > 0).reduce((s, i) => s + i.pendingCount, 0);
  const todo = [needMyVote && `ждут вашего голоса: <b>${needMyVote}</b>`, needMyCheck && `чеков на проверку: <b>${needMyCheck}</b>`].filter(Boolean);
  const tabs = ['voting', 'funding', 'done', 'rejected'];
  const list = state.items.filter((i) => i.status === state.tab);

  shell(`
    <div class="family-head">
      <div class="grow">
        <h1>Привет, ${esc(state.me.name)} 👋</h1>
        <p class="muted" style="margin:4px 0 0">${todo.length ? '⚡ ' + todo.join(' · ') : 'Что купим вместе?'}</p>
      </div>
      <a class="stack" href="#/family" title="Семья">${state.members.slice(0, 6).map((m) => avatar(m)).join('')}</a>
    </div>
    <div data-install-slot="home">${installBox('home')}</div>
    <div data-push-slot="home"></div>
    ${state.members.length < 2 ? `<div class="note" style="margin-bottom:16px">Вы пока один в семье. <a href="#/family">Пригласите родных</a> — без них голосование не начнётся.</div>` : ''}
    <div class="tabs">${tabs.map((t) => `<button class="tab ${t === state.tab ? 'active' : ''}" data-tab="${t}">${STATUS[t].icon} ${STATUS[t].label}<span class="count">${counts[t]}</span></button>`).join('')}</div>
    ${list.length ? `<div class="grid">${list.map(itemCard).join('')}</div>` : `
      <div class="empty"><div class="big">${STATUS[state.tab].icon}</div>
      ${state.tab === 'voting' ? 'Пока никто ничего не предложил.<br>Нажмите «Хочу вещь», чтобы начать.' : 'Здесь пока пусто'}</div>`}
    <button class="fab" onclick="location.hash='#/new'"><span style="font-size:22px">＋</span> Хочу вещь</button>`);

  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderHome(); }));
  bindInstall();
  fillPush();
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
      ${i.status === 'funding' ? `<div class="money-row"><span class="muted">Осталось</span><b>${money(i.remaining)}</b></div>` : ''}
      ${i.pendingCount ? `<div class="note small">⏳ На проверке: ${money(i.pendingSum)}${i.creatorId === state.me.id ? ' — проверьте чеки' : ''}</div>` : ''}`;
  }
  return `<a class="card item-card" href="#/item/${i.id}">
    <div class="item-photo">${i.hasPhoto ? `<img src="/api/items/${i.id}/photo" alt="" loading="lazy">` : '<div class="ph">🎁</div>'}${badge(i.status)}</div>
    <div class="item-body">
      <h3>${esc(i.title)}</h3>
      <div class="price">${money(i.price)}</div>
      ${extra}
      <div class="item-meta">${avatar(author, 'sm')}<span>${esc(author?.name || '—')}</span>
        ${i.messageCount ? `<span class="spacer"></span><span>💬 ${i.messageCount}</span>` : ''}</div>
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
        <div class="row">
          <div class="field"><label>Номер Kaspi для переводов</label><input class="input" name="kaspiPhone" type="tel" inputmode="tel" required placeholder="+7 7XX XXX XX XX" value="${esc(state.me.kaspiPhone || '')}"></div>
          <div class="field"><label>Имя в Kaspi <span class="muted">(необяз.)</span></label><input class="input" name="kaspiName" maxlength="60" placeholder="Ерлан А." value="${esc(state.me.name)}"></div>
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
      state.shareHint = { id, text: 'Заявка создана! Сообщите семье в WhatsApp, чтобы проголосовали.' };
      toast('Отправлено на голосование');
      go('/item/' + id);
    });
  };
}

// ---------- item page ----------
const C_STATUS = {
  pending: '<span class="badge badge-voting">⏳ Проверяется</span>',
  confirmed: '<span class="badge badge-done">✅ Получено</span>',
  rejected: '<span class="badge badge-rejected">❌ Отклонено</span>',
};

async function renderItem(id, opts = {}) {
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
  const hint = state.shareHint && state.shareHint.id === i.id ? state.shareHint : null;
  state.shareHint = null;
  // последний свой взнос отклонён и ещё не переотправлен
  const myLast = i.contributions.find((c) => c.userId === state.me.id);
  const myRejected = myLast && myLast.status === 'rejected' ? myLast : null;

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
    const kaspi = `
      <div class="kaspi">
        <div class="kaspi-logo">K</div>
        <div class="grow"><div class="muted small">Перевод на Kaspi${i.kaspiName ? ' · ' + esc(i.kaspiName) : ''}</div>
          <div class="kaspi-phone">${esc(i.kaspiPhone || 'номер не указан')}</div></div>
        ${i.kaspiPhone ? '<button type="button" class="btn btn-sm btn-ghost" id="copyKaspi">Копировать</button>' : ''}
      </div>
      ${i.kaspiPhone ? `<button type="button" class="btn btn-kaspi btn-block" id="openKaspi" style="margin-top:10px">
        <span class="kaspi-logo sm">K</span> Перевести в Kaspi</button>
        <p class="muted small" style="margin:6px 0 0">Номер скопируется и откроется Kaspi: <b>Переводы → Клиенту Kaspi → По номеру телефона</b> → вставьте номер.</p>` : ''}`;
    if (i.available <= 0) {
      action = `${kaspi}<div class="note" style="margin-top:12px">Вся оставшаяся сумма уже отправлена и ждёт подтверждения ${esc(author?.name || 'автора')}.</div>`;
    } else {
      action = `<h3 style="margin-bottom:10px">💚 Помочь</h3>
        ${kaspi}
        <ol class="steps"><li>Скопируйте номер и переведите деньги в приложении Kaspi.</li>
          <li>Сделайте скриншот или скачайте чек.</li>
          <li>Прикрепите чек ниже — ${isMine ? 'взнос засчитается сразу' : `${esc(author?.name || 'автор')} проверит и подтвердит`}.</li></ol>
        <form id="cf">
          ${myRejected ? `<div class="error-box">Ваш перевод ${money(myRejected.amount)} отклонён: «${esc(myRejected.rejectReason)}». Проверьте и отправьте ещё раз.</div>` : ''}
          <div class="field"><label>Сколько перевели, ₸</label><input class="input" name="amount" type="number" inputmode="numeric" min="1" max="${i.available}" step="1" placeholder="Не больше ${money(i.available)}" required></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 14px">
            ${[1000, 5000, 10000].filter((v) => v < i.available).map((v) => `<button type="button" class="btn btn-ghost btn-sm" data-q="${v}">${money(v)}</button>`).join('')}
            <button type="button" class="btn btn-ghost btn-sm" data-q="${i.available}">Всё: ${money(i.available)}</button>
          </div>
          <label class="receipt-drop" id="rdrop"><input type="file" accept="image/*,application/pdf" id="rfile">
            <span id="rlabel">🧾 Прикрепить чек (фото или PDF)</span></label>
          <div class="field" style="margin-top:14px"><input class="input" name="comment" maxlength="200" placeholder="Комментарий (необязательно)"></div>
          <button class="btn btn-primary btn-block">Я перевёл(а) — отправить чек</button>
        </form>`;
    }
  } else if (i.status === 'done') {
    action = `<div class="note" style="background:var(--ok-soft);color:var(--ok)">🎉 Деньги собраны! Можно покупать.</div>`;
  } else {
    action = `<div class="note" style="background:var(--no-soft);color:var(--no)">Семья решила, что эта вещь пока не нужна.</div>`;
  }

  const showMoney = i.status === 'funding' || i.status === 'done';
  const contribRow = (c) => {
    const m = member(c.userId);
    const receipt = c.receiptType
      ? `<a href="/api/contributions/${c.id}/receipt" target="_blank" rel="noopener" class="small">🧾 ${c.receiptType === 'pdf' ? 'Чек (PDF)' : 'Чек'}</a>` : '';
    const review = isMine && c.status === 'pending' ? `
      <div class="review">
        <button class="btn btn-ok btn-sm" data-confirm="${c.id}">✅ Деньги пришли</button>
        <button class="btn btn-ghost btn-sm" data-reject="${c.id}">❌ Не пришли</button>
        <form class="reject-form hidden" data-rform="${c.id}">
          <input class="input" name="reason" maxlength="200" required placeholder="Причина: например, перевода нет в Kaspi">
          <button class="btn btn-no btn-sm">Отклонить</button>
        </form>
      </div>` : '';
    return `<div class="list-row contrib">${avatar(m)}
      <div class="grow"><div class="name">${esc(m?.name || '—')} · <b>${money(c.amount)}</b></div>
        <div class="contrib-meta">${C_STATUS[c.status] || ''} ${receipt}
          <button type="button" class="link-btn small" data-discuss="${c.id}">💬 Обсудить</button></div>
        ${c.comment ? `<div class="muted small">${esc(c.comment)}</div>` : ''}
        ${c.status === 'rejected' && c.rejectReason ? `<div class="vote-no small">Причина: ${esc(c.rejectReason)}</div>` : ''}
        ${review}</div></div>`;
  };

  shell(`
    <a class="back" href="#/">← Все вещи</a>
    ${hint ? `<div class="share-hint"><span>${esc(hint.text)}</span><a class="btn btn-wa" href="${waLink(i)}" target="_blank" rel="noopener">📲 WhatsApp</a></div>` : ''}
    <div class="detail">
      <div>
        <div class="detail-photo">${i.hasPhoto ? `<img src="/api/items/${i.id}/photo" alt="">` : '<div class="ph">🎁</div>'}</div>
        ${i.description ? `<div class="card card-pad section"><h3 style="margin-bottom:6px">Описание</h3><p style="margin:0;white-space:pre-wrap">${esc(i.description)}</p></div>` : ''}
      </div>
      <div>
        <div class="card card-pad">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            ${badge(i.status)}
            <a class="btn btn-wa btn-sm" href="${waLink(i)}" target="_blank" rel="noopener">📲 В WhatsApp</a>
          </div>
          <h1 style="margin:10px 0 4px">${esc(i.title)}</h1>
          <div class="item-meta">${avatar(author, 'sm')}<span>${esc(author?.name || '—')} · ${esc(author?.role || '')}</span></div>
          <div class="stats">
            <div class="stat"><div class="label">Цена</div><div class="val">${money(i.price)}</div></div>
            <div class="stat"><div class="label">Собрано</div><div class="val">${money(i.collected)}</div></div>
            <div class="stat"><div class="label">Осталось</div><div class="val">${money(i.remaining)}</div></div>
          </div>
          ${showMoney ? `<div class="progress">
              <div style="width:${pct(i.collected, i.price)}%"></div>
              <div class="pending-bar" style="width:${pct(i.pendingSum, i.price)}%"></div></div>
            <p class="muted small" style="margin:6px 0 16px">${pct(i.collected, i.price)}% · своих у автора ${money(i.ownAmount)}${i.pendingSum ? ` · ⏳ на проверке ${money(i.pendingSum)}` : ''}</p>` : ''}
          ${action}
          ${isMine && i.contribCount === 0 ? `<button class="btn btn-ghost btn-sm" id="del" style="margin-top:14px">Удалить заявку</button>` : ''}
        </div>

        ${showMoney ? `<div class="card card-pad section">
          <h3>Переводы${isMine && i.pendingCount ? ` <span class="badge badge-voting">проверьте: ${i.pendingCount}</span>` : ''}</h3>
          <div class="list">${i.contributions.length ? i.contributions.map(contribRow).join('') : '<p class="muted">Пока никто не перевёл — будьте первым!</p>'}</div>
        </div>` : ''}

        <div class="card card-pad section" id="chat">
          <h3>💬 Обсуждение</h3>
          <div class="chat-list" id="chatList"></div>
          <form class="chat-form" id="chatForm">
            <div id="replyChip"></div>
            <div class="chat-input">
              <textarea class="input" name="text" rows="1" maxlength="1000" placeholder="Написать семье…" required></textarea>
              <button class="btn btn-primary" title="Отправить">➤</button>
            </div>
          </form>
        </div>

        <div class="card card-pad section">
          <h3>Голоса семьи</h3>
          <div class="list">${voters.length ? voters.map((m) => {
            const v = voteOf(m.id);
            const st = v ? (v.approve ? '<span class="vote-yes">👍 За</span>' : '<span class="vote-no">👎 Против</span>') : '<span class="vote-wait">⏳ Ждём</span>';
            return `<div class="list-row">${avatar(m)}<div class="grow"><div class="name">${esc(m.name)}</div><div class="muted small">${roleLine(m)}</div></div>${st}</div>`;
          }).join('') : '<p class="muted">В семье пока больше никого нет</p>'}</div>
        </div>
      </div>
    </div>`);

  setupChat(i, opts);

  document.querySelectorAll('[data-vote]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const r = await api(`/items/${id}/vote`, { method: 'POST', body: { approve: b.dataset.vote === '1' } });
    toast('Голос учтён');
    if (r.status === 'funding') state.shareHint = { id, text: 'Все одобрили — сбор начался! Сообщите семье в WhatsApp.' };
    renderItem(id);
  })));

  const copyPhone = async () => {
    try {
      await navigator.clipboard.writeText(i.kaspiPhone.replace(/[^\d+]/g, ''));
      return true;
    } catch {
      return false;
    }
  };
  const copy = document.getElementById('copyKaspi');
  if (copy) copy.onclick = async () => toast((await copyPhone()) ? 'Номер скопирован: ' + i.kaspiPhone : i.kaspiPhone);
  const open = document.getElementById('openKaspi');
  if (open) {
    open.onclick = async () => {
      const copied = await copyPhone();
      const link = kaspiAppLink();
      if (!link) return toast(`${copied ? 'Номер скопирован. ' : ''}Откройте Kaspi на телефоне: Переводы → Клиенту Kaspi → ${i.kaspiPhone}`);
      toast(copied ? 'Номер скопирован — открываем Kaspi…' : 'Открываем Kaspi… Номер: ' + i.kaspiPhone);
      setTimeout(() => (location.href = link), 500);
    };
  }

  const cf = document.getElementById('cf');
  if (cf) {
    let receipt = null;
    if (myRejected) cf.amount.value = Math.min(myRejected.amount, i.available);
    cf.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => (cf.amount.value = b.dataset.q)));
    document.getElementById('rfile').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const drop = document.getElementById('rdrop');
      try {
        receipt = await readReceipt(file);
        const isPdf = file.type === 'application/pdf';
        drop.classList.add('has-file');
        drop.querySelector('img')?.remove();
        document.getElementById('rlabel').textContent = isPdf ? `📄 ${file.name}` : '✅ Чек прикреплён — нажмите, чтобы заменить';
        if (!isPdf) drop.insertAdjacentHTML('afterbegin', `<img src="${receipt}" alt="">`);
      } catch (er) {
        toast(er.message, true);
      }
    };
    cf.onsubmit = (e) => {
      e.preventDefault();
      if (!receipt) return toast('Прикрепите чек перевода', true);
      withBusy(cf.querySelector('button:not([type=button])'), async () => {
        const r = await api(`/items/${id}/contribute`, { method: 'POST', body: { ...formData(cf), receipt } });
        toast(r.status === 'pending' ? 'Чек отправлен — ждём подтверждения 💚' : 'Взнос засчитан 💚');
        state.shareHint = { id, text: 'Спасибо! Напишите семье в WhatsApp, сколько осталось собрать.' };
        renderItem(id);
      });
    };
  }

  document.querySelectorAll('[data-confirm]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const r = await api(`/contributions/${b.dataset.confirm}/confirm`, { method: 'POST' });
    toast('Взнос подтверждён ✅');
    if (r.status === 'done') state.shareHint = { id, text: '🎉 Всё собрано! Обрадуйте семью в WhatsApp.' };
    renderItem(id);
  })));
  document.querySelectorAll('[data-reject]').forEach((b) => (b.onclick = () => {
    const form = document.querySelector(`[data-rform="${b.dataset.reject}"]`);
    form.classList.toggle('hidden');
    form.reason.focus();
  }));
  document.querySelectorAll('[data-rform]').forEach((form) => (form.onsubmit = (e) => {
    e.preventDefault();
    withBusy(form.querySelector('button'), async () => {
      await api(`/contributions/${form.dataset.rform}/reject`, { method: 'POST', body: formData(form) });
      toast('Взнос отклонён — сумма снова доступна для сбора');
      renderItem(id);
    });
  }));

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

// ---------- обсуждение вещи ----------
// Время из БД: Postgres отдаёт ISO, SQLite — "YYYY-MM-DD HH:MM:SS" в UTC
function parseTime(t) {
  const s = String(t);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}
function chatTime(t) {
  const d = parseTime(t);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

function quoteHtml(c) {
  if (!c) return '';
  const who = member(c.userId);
  return `<div class="chat-quote">↪ ${esc(who?.name || '—')} · ${money(c.amount)}${c.status ? ' ' + (C_STATUS[c.status] || '') : ''}</div>`;
}

function msgHtml(m) {
  const mine = m.userId === state.me.id;
  const who = member(m.userId);
  return `<div class="msg ${mine ? 'mine' : ''}" data-mid="${m.id}">
    ${mine ? '' : avatar(who, 'sm')}
    <div class="bubble">
      ${mine ? '' : `<div class="msg-name">${esc(who?.name || '—')}</div>`}
      ${quoteHtml(m.contribution)}
      <div class="msg-text">${esc(m.text)}</div>
      <div class="msg-meta">${chatTime(m.at)}${mine ? ` · <button type="button" class="link-btn" data-mdel="${m.id}">удалить</button>` : ''}</div>
    </div></div>`;
}

function setupChat(item, opts) {
  clearInterval(state.chatTimer);
  const list = document.getElementById('chatList');
  const form = document.getElementById('chatForm');
  const chip = document.getElementById('replyChip');
  let lastId = 0;
  let replyTo = null;

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const append = (msgs, forceScroll) => {
    if (!msgs.length) return;
    const stick = forceScroll || nearBottom();
    list.querySelector('.chat-empty')?.remove();
    list.insertAdjacentHTML('beforeend', msgs.map(msgHtml).join(''));
    lastId = Math.max(lastId, ...msgs.map((m) => m.id));
    if (stick) list.scrollTop = list.scrollHeight;
  };
  list.innerHTML = '<p class="muted chat-empty">Пока тихо. Спросите, уточните, поблагодарите — все увидят и получат уведомление.</p>';
  append(item.messages, true);

  const poll = async () => {
    if (document.hidden || !document.body.contains(list)) return;
    try {
      append(await api(`/items/${item.id}/messages?after=${lastId}`));
    } catch {}
  };
  state.chatTimer = setInterval(poll, 8000);

  const setReply = (c) => {
    replyTo = c;
    chip.innerHTML = c
      ? `<div class="reply-chip">${quoteHtml({ ...c, status: null })}<button type="button" class="link-btn" id="replyClear">✕</button></div>`
      : '';
    if (c) document.getElementById('replyClear').onclick = () => setReply(null);
  };
  document.querySelectorAll('[data-discuss]').forEach((b) => (b.onclick = () => {
    const c = item.contributions.find((x) => x.id === Number(b.dataset.discuss));
    setReply(c);
    document.getElementById('chat').scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.text.focus({ preventScroll: true });
  }));

  const ta = form.text;
  ta.oninput = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };
  // Enter — отправить, Shift+Enter — новая строка (на компьютере)
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    withBusy(form.querySelector('button.btn-primary'), async () => {
      await api(`/items/${item.id}/messages`, { method: 'POST', body: { text, contributionId: replyTo?.id } });
      ta.value = '';
      ta.oninput();
      setReply(null);
      append(await api(`/items/${item.id}/messages?after=${lastId}`), true);
    });
  };

  list.onclick = (e) => {
    const del = e.target.closest('[data-mdel]');
    if (!del) return;
    if (del.dataset.armed !== '1') {
      del.dataset.armed = '1';
      del.textContent = 'точно удалить?';
      return;
    }
    withBusy(del, async () => {
      await api('/messages/' + del.dataset.mdel, { method: 'DELETE' });
      list.querySelector(`[data-mid="${del.dataset.mdel}"]`)?.remove();
    });
  };

  if (opts.chat) setTimeout(() => document.getElementById('chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
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
          <div class="field"><label>Мой номер Kaspi</label><input class="input" name="kaspiPhone" type="tel" inputmode="tel" placeholder="+7 7XX XXX XX XX" value="${esc(state.me.kaspiPhone || '')}">
            <span class="hint">Подставится, когда вы создаёте вещь</span></div>
          <label class="check"><input type="checkbox" name="notifyEmail" ${state.me.notifyEmail ? 'checked' : ''}>
            <span>Присылать письма на ${esc(state.me.email)}<br><span class="muted small">новые вещи, голоса, переводы и их проверка${state.mailEnabled ? '' : ' · отправка писем на сайте пока не настроена'}</span></span></label>
          <button class="btn btn-primary btn-block">Сохранить</button>
          <button type="button" class="btn btn-ghost btn-block" id="logout" style="margin-top:10px">Выйти</button>
        </form>
        <div class="section" data-install-slot="profile">${installBox('profile')}</div>
        <div class="section" data-push-slot="profile"></div>
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
      body.notifyEmail = pf.notifyEmail.checked;
      if (avatarData) body.avatar = avatarData;
      await api('/me', { method: 'PUT', body });
      toast('Профиль сохранён');
      renderFamily();
    });
  };
  bindInstall();
  fillPush();
  document.getElementById('logout').onclick = async () => {
    // отвязываем это устройство от аккаунта, чтобы чужие уведомления сюда не приходили
    try {
      const sub = await currentSub();
      if (sub) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    } catch {}
    pushSynced = false;
    await api('/logout', { method: 'POST' });
    state.me = null;
    go('/login');
  };
}

route();
