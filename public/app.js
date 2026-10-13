'use strict';

// ---------- state & utils ----------
const state = { me: null, family: null, members: [], former: [], roles: [], items: [], tab: 'voting', lang: 'ru' };
const $app = document.getElementById('app');

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- язык ----------
state.lang = store.get('lang') || (/^kk/i.test(navigator.language || '') ? 'kk' : 'ru');
document.documentElement.lang = state.lang;
const LOCALE = () => (state.lang === 'kk' ? 'kk-KZ' : 'ru-RU');

// t('русский текст', {подстановки}) — перевод из public/i18n.js
function t(s, vars) {
  let r = (state.lang === 'kk' && window.I18N_KK && window.I18N_KK[s]) || s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return r;
}
const roleName = (r) => (state.lang === 'kk' && window.I18N_ROLES_KK && window.I18N_ROLES_KK[r]) || r;

async function setLang(lang) {
  state.lang = lang;
  store.set('lang', lang);
  document.documentElement.lang = lang;
  if (state.me) api('/me/lang', { method: 'PUT', body: { lang } }).catch(() => {});
  route();
}
const langToggle = () =>
  `<button type="button" class="lang-btn" data-lang="${state.lang === 'kk' ? 'ru' : 'kk'}" title="${state.lang === 'kk' ? 'Русский' : 'Қазақша'}">${state.lang === 'kk' ? 'РУС' : 'ҚАЗ'}</button>`;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (b) setLang(b.dataset.lang);
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('ru-RU') + ' ₸';
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const member = (id) => state.members.find((m) => m.id === id) || state.former.find((m) => m.id === id);
const isOwner = () => state.family && state.me && state.family.ownerId === state.me.id;
// версия из ?v= в адресе этого скрипта; сервер шлёт свою в X-App-Version
const APP_VERSION = new URL(document.currentScript.src).searchParams.get('v');
const COLORS = ['#0f766e', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#059669', '#dc2626', '#4f46e5'];

async function api(path, opts = {}) {
  const headers = { 'X-Lang': state.lang };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers,
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
    const err = new Error(data.error || t('Ошибка сети'));
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3000);
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
  return esc(roleName(m.role)) + (rel ? ' · ' + t('для {name}', { name: esc(rel.name) }) : '');
}

const STATUS = {
  voting: { label: 'Голосование', cls: 'badge-voting', icon: '🗳️' },
  funding: { label: 'Идёт сбор', cls: 'badge-funding', icon: '💰' },
  done: { label: 'Собрано', cls: 'badge-done', icon: '✅' },
  bought: { label: 'Куплено', cls: 'badge-bought', icon: '🛍️' },
  rejected: { label: 'Отклонено', cls: 'badge-rejected', icon: '✖️' },
};
const badge = (s) => `<span class="badge ${STATUS[s].cls}">${STATUS[s].icon} ${t(STATUS[s].label)}</span>`;

// ---------- даты и сроки ----------
// Время из БД: Postgres отдаёт ISO, SQLite — "YYYY-MM-DD HH:MM:SS" в UTC
function parseTime(v) {
  const s = String(v);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}
const ddmm = (s) => (s ? s.split('-').reverse().join('.') : '');
const dateLong = (v) => parseTime(v).toLocaleDateString(LOCALE(), { day: 'numeric', month: 'long', year: 'numeric' });
// сегодня в Казахстане (UTC+5) — так же, как на сервере
const todayKz = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const daysLeft = (d) => Math.round((Date.parse(d) - Date.parse(todayKz())) / 864e5);

function deadlineChip(i) {
  if (!i.deadline || !['voting', 'funding'].includes(i.status)) return '';
  const n = daysLeft(i.deadline);
  const cls = n < 0 ? 'late' : n <= 3 ? 'soon' : '';
  const text = n < 0 ? t('срок прошёл') : n === 0 ? t('сегодня') : t('ещё {n} дн.', { n });
  return `<span class="deadline ${cls}">⏰ ${t('до {date}', { date: ddmm(i.deadline) })} · ${text}</span>`;
}

// ---------- файлы ----------
// Уменьшаем картинку на клиенте, чтобы не гонять мегабайты
function resizeImage(file, max, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error(t('Выберите изображение')));
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
    img.onerror = () => reject(new Error(t('Не удалось прочитать изображение')));
    img.src = url;
  });
}

// Чек / фото покупки: фото сжимаем, PDF берём как есть
function readDoc(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 4 * 1024 * 1024) return Promise.reject(new Error(t('PDF больше 4 МБ')));
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error(t('Не удалось прочитать файл')));
      r.readAsDataURL(file);
    });
  }
  return resizeImage(file, 1600, 0.85);
}

// Поле «прикрепить файл» с превью; возвращает функцию, отдающую выбранный файл
function bindDocDrop(dropId, inputId, labelId, doneText) {
  let data = null;
  document.getElementById(inputId).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const drop = document.getElementById(dropId);
    try {
      data = await readDoc(file);
      const isPdf = file.type === 'application/pdf';
      drop.classList.add('has-file');
      drop.querySelector('img')?.remove();
      document.getElementById(labelId).textContent = isPdf ? `📄 ${file.name}` : doneText;
      if (!isPdf) drop.insertAdjacentHTML('afterbegin', `<img src="${data}" alt="">`);
    } catch (er) {
      toast(er.message, true);
    }
  };
  return () => data;
}

// ---------- Kaspi и WhatsApp ----------
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
  const v = { author: member(i.creatorId)?.name || '', title: i.title, price: money(i.price), url: itemUrl(i.id) };
  if (i.status === 'voting') return t('🗳️ {author} хочет купить «{title}» за {price}.\nНужна ли эта вещь? Проголосуйте:\n{url}', v);
  if (i.status === 'funding') {
    return t('💰 Сбор на «{title}»: собрано {collected} из {price}, осталось {left}.\nKaspi: {kaspi}\nПомочь и прикрепить чек:\n{url}', {
      ...v,
      collected: money(i.collected),
      left: money(i.remaining),
      kaspi: i.kaspiPhone + (i.kaspiName ? ` (${i.kaspiName})` : ''),
    });
  }
  if (i.status === 'done') return t('🎉 Собрали на «{title}» — {price}! Спасибо всем 💚\n{url}', v);
  if (i.status === 'bought') return t('🛍️ «{title}» куплено! Фото покупки:\n{url}', v);
  return t('«{title}» — семья решила пока не покупать.\n{url}', v);
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

// кнопка с подтверждением вторым нажатием (без системных диалогов)
function armed(btn, confirmText, fn) {
  let ready = false;
  btn.onclick = () => {
    if (!ready) {
      ready = true;
      btn.textContent = confirmText;
      btn.classList.add('btn-no');
      return;
    }
    withBusy(btn, fn);
  };
}

// ---------- установка как приложение (PWA) ----------
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canOfferInstall = () => !isStandalone() && (installPrompt || isIOS());

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
  toast(t('Приложение установлено 🎉'));
});

function installBox(where) {
  if (!canOfferInstall()) return '';
  if (where === 'home' && store.get('installDismissed')) return '';
  const body = installPrompt
    ? `<button class="btn btn-primary btn-sm" data-install>📲 ${t('Установить')}</button>`
    : `<div class="small">${t('Нажмите <b>«Поделиться»</b> <span class="ios-share">⬆︎</span> внизу Safari → <b>«На экран „Домой“»</b> → <b>«Добавить»</b>.')}</div>`;
  return `<div class="install-card">
    <img src="/icons/icon-192.png" alt="" width="44" height="44">
    <div class="grow"><b>${t('Установить как приложение')}</b>
      <div class="muted small">${t('Иконка на главном экране, открывается без браузера')}</div>
      <div style="margin-top:8px">${body}</div></div>
    ${where === 'home' ? `<button class="icon-btn" data-install-close title="${t('Скрыть')}">✕</button>` : ''}
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
      ? t('Уведомления запрещены в настройках браузера — разрешите их для этого сайта')
      : t('Разрешение не выдано'));
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
  const title = t('Уведомления на телефон');
  if (pushNeedsInstall()) {
    return where === 'profile'
      ? `<div class="install-card"><div class="push-ico">🔔</div><div class="grow"><b>${title}</b>
          <div class="muted small">${t('На iPhone уведомления работают только в установленном приложении: установите его (см. выше) и откройте с экрана «Домой».')}</div></div></div>`
      : '';
  }
  if (!pushSupported()) {
    return where === 'profile'
      ? `<div class="install-card"><div class="push-ico">🔕</div><div class="grow"><b>${title}</b><div class="muted small">${t('Этот браузер не поддерживает уведомления. Откройте сайт в Chrome или установите приложение.')}</div></div></div>`
      : '';
  }
  const sub = await currentSub().catch(() => null);
  const on = !!sub && Notification.permission === 'granted';
  if (where === 'home' && (on || Notification.permission === 'denied' || store.get('pushDismissed'))) return '';
  if (where === 'home') {
    return `<div class="install-card"><div class="push-ico">🔔</div>
      <div class="grow"><b>${t('Включите уведомления')}</b>
        <div class="muted small">${t('Узнавайте сразу о новых вещах, голосах и переводах')}</div>
        <div style="margin-top:8px"><button class="btn btn-primary btn-sm" data-push-on>${t('Включить')}</button></div></div>
      <button class="icon-btn" data-push-close title="${t('Скрыть')}">✕</button></div>`;
  }
  return `<div class="install-card"><div class="push-ico">${on ? '🔔' : '🔕'}</div>
    <div class="grow"><b>${title}: ${on ? t('включены') : t('выключены')}</b>
      <div class="muted small">${Notification.permission === 'denied'
        ? t('Запрещены в настройках браузера. Разрешите уведомления для этого сайта и обновите страницу.')
        : t('Новые вещи, голоса, сообщения, переводы и напоминания.')}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${on
        ? `<button class="btn btn-ghost btn-sm" data-push-test>${t('Проверить')}</button><button class="btn btn-ghost btn-sm" data-push-off>${t('Выключить')}</button>`
        : Notification.permission === 'denied' ? '' : `<button class="btn btn-primary btn-sm" data-push-on>${t('Включить')}</button>`}</div>
    </div></div>`;
}

async function fillPush() {
  for (const el of document.querySelectorAll('[data-push-slot]')) {
    el.innerHTML = await pushBox(el.dataset.pushSlot);
  }
  document.querySelectorAll('[data-push-on]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    await enablePush();
    toast(t('Уведомления включены 🔔'));
    fillPush();
  })));
  document.querySelectorAll('[data-push-off]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    await disablePush();
    toast(t('Уведомления выключены'));
    fillPush();
  })));
  document.querySelectorAll('[data-push-test]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const r = await api('/push/test', { method: 'POST' });
    toast(r.sent ? t('Отправлено — уведомление придёт через пару секунд') : t('Не удалось доставить — выключите и включите уведомления снова'), !r.sent);
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
    state.former = d.former || [];
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

  if (page === 'forgot') return renderForgot();
  if (page === 'reset' && id) return renderReset(id);
  if (page === 'login' || page === 'register' || page === 'join') {
    if (await loadMe()) return go('/');
    return page === 'login' ? renderLogin() : renderRegister(page === 'join' ? id : '');
  }
  if (!state.me && !(await loadMe())) return go('/login');

  window.scrollTo(0, 0);
  if (page === 'new') return renderItemForm();
  if (page === 'edit' && id) return renderItemForm(Number(id));
  if (page === 'item' && id) return renderItem(Number(id), { chat: query === 'chat' });
  if (page === 'family') return renderFamily();
  if (page === 'stats') return renderStats();
  return renderHome();
}
const go = (p) => (location.hash = '#' + p);
window.addEventListener('hashchange', route);

function shell(content) {
  $app.innerHTML = `
    <header class="topbar"><div class="wrap">
      <a class="brand" href="#/"><div class="brand-mark">🏠</div><span>${esc(state.family.name)}</span></a>
      <div class="spacer"></div>
      ${langToggle()}
      <a class="icon-btn" href="#/stats" title="${t('Статистика')}">📊</a>
      <a href="#/family" title="${t('Семья и профиль')}">${avatar(state.me)}</a>
    </div></header>
    <main><div class="wrap">${content}</div></main>`;
}

function authShell(title, subtitle, body) {
  $app.innerHTML = `
    <div class="auth-shell"><div class="auth-card">
      <div class="auth-lang">${langToggle()}</div>
      <div class="auth-head"><div class="brand-mark">🏠</div><h1>${title}</h1>
        <p class="muted">${subtitle}</p></div>
      ${body}
    </div></div>`;
}
const showErr = (msg) => {
  document.getElementById('err').innerHTML = `<div class="error-box">${esc(msg)}</div>`;
};

// ---------- вход, регистрация, пароль ----------
function renderLogin() {
  authShell('Отбасы Қоры', t('Семья решает вместе — и вместе собирает'), `
    <form class="card card-pad" id="f">
      <div id="err"></div>
      <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label>${t('Пароль')}</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-block">${t('Войти')}</button>
      <p class="small" style="text-align:center;margin:14px 0 0"><a href="#/forgot">${t('Забыли пароль?')}</a></p>
      <p class="muted small" style="text-align:center;margin:8px 0 0">${t('Нет аккаунта?')} <a href="#/register">${t('Зарегистрироваться')}</a></p>
    </form>`);
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: formData(f) });
      await loadMe();
      if (state.me.lang && state.me.lang !== state.lang && !store.get('lang')) state.lang = state.me.lang;
      go('/');
    } catch (er) {
      showErr(er.message);
    } finally {
      btn.disabled = false;
    }
  };
}

function renderForgot() {
  authShell(t('Восстановление пароля'), t('Пришлём ссылку для нового пароля на ваш email'), `
    <form class="card card-pad" id="f">
      <div id="err"></div>
      <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div>
      <button class="btn btn-primary btn-block">${t('Отправить ссылку')}</button>
      <p class="muted small" style="text-align:center;margin:16px 0 0"><a href="#/login">← ${t('Вернуться ко входу')}</a></p>
    </form>`);
  const f = document.getElementById('f');
  f.onsubmit = (e) => {
    e.preventDefault();
    withBusy(f.querySelector('button'), async () => {
      try {
        await api('/password/forgot', { method: 'POST', body: formData(f) });
        f.innerHTML = `<div class="note" style="background:var(--ok-soft);color:var(--ok)">${t('Если такой email зарегистрирован, мы отправили письмо со ссылкой. Проверьте «Входящие» и «Спам». Ссылка действует 1 час.')}</div>
          <p class="muted small" style="text-align:center;margin:16px 0 0"><a href="#/login">← ${t('Вернуться ко входу')}</a></p>`;
      } catch (er) {
        showErr(er.message);
      }
    });
  };
}

function renderReset(token) {
  authShell(t('Новый пароль'), t('Придумайте новый пароль для входа'), `
    <form class="card card-pad" id="f">
      <div id="err"></div>
      <div class="field"><label>${t('Новый пароль')}</label><input class="input" name="password" type="password" minlength="6" autocomplete="new-password" required>
        <span class="hint">${t('Не короче 6 символов')}</span></div>
      <div class="field"><label>${t('Повторите пароль')}</label><input class="input" name="password2" type="password" minlength="6" autocomplete="new-password" required></div>
      <button class="btn btn-primary btn-block">${t('Сохранить и войти')}</button>
    </form>`);
  const f = document.getElementById('f');
  f.onsubmit = (e) => {
    e.preventDefault();
    const d = formData(f);
    if (d.password !== d.password2) return showErr(t('Пароли не совпадают'));
    withBusy(f.querySelector('button'), async () => {
      try {
        await api('/password/reset', { method: 'POST', body: { token, password: d.password } });
        await loadMe();
        toast(t('Пароль изменён'));
        go('/');
      } catch (er) {
        showErr(er.message);
      }
    });
  };
}

function renderRegister(code = '') {
  let mode = code ? 'join' : 'create';
  let avatarData = null;
  let preview = null;
  const roleOpts = state.roles.map((r) => `<option value="${esc(r)}">${esc(roleName(r))}</option>`).join('');

  authShell(t('Регистрация'), t('Создайте семью или присоединитесь по коду'), `
    <form class="card card-pad" id="f">
      <div class="segmented">
        <button type="button" data-mode="create">${t('Новая семья')}</button>
        <button type="button" data-mode="join">${t('Есть код семьи')}</button>
      </div>
      <div id="err"></div>

      <div class="avatar-picker">
        <div id="av" class="avatar">📷</div>
        <label class="file-label btn btn-ghost btn-sm">${t('Загрузить аватар')}<input type="file" accept="image/*" id="avFile"></label>
      </div>

      <div class="field"><label>${t('Ваше имя')}</label><input class="input" name="name" required maxlength="60" placeholder="${t('Например, Ерлан')}"></div>

      <div id="createBox" class="field"><label>${t('Название семьи')}</label>
        <input class="input" name="familyName" maxlength="60" placeholder="${t('Семья Ахметовых')}"></div>

      <div id="joinBox">
        <div class="field"><label>${t('Код семьи')}</label>
          <input class="input" name="inviteCode" id="code" value="${esc(code)}" placeholder="${t('Например, 4F9A2C1B')}" style="text-transform:uppercase">
          <span class="hint" id="famHint">${t('Код можно узнать у любого члена семьи')}</span></div>
      </div>

      <div class="field"><label>${t('Кто вы в семье')}</label>
        <select class="input" name="role" required><option value="">— ${t('выберите')} —</option>${roleOpts}</select></div>

      <div class="field" id="relBox"><label>${t('Кому вы приходитесь')} <span class="muted">(${t('необязательно')})</span></label>
        <select class="input" name="relationTo" id="rel"><option value="">—</option></select>
        <span class="hint">${t('Например: келін → для кого; братишка → чей')}</span></div>

      <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label>${t('Пароль')}</label><input class="input" name="password" type="password" minlength="6" autocomplete="new-password" required>
        <span class="hint">${t('Не короче 6 символов')}</span></div>
      <button class="btn btn-primary btn-block">${t('Зарегистрироваться')}</button>
      <p class="muted small" style="text-align:center;margin:16px 0 0">${t('Уже есть аккаунт?')} <a href="#/login">${t('Войти')}</a></p>
    </form>`);

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
  let timer;
  const lookup = async () => {
    const v = codeInput.value.trim();
    const hint = document.getElementById('famHint');
    preview = null;
    if (v.length < 4) {
      hint.textContent = t('Код можно узнать у любого члена семьи');
      return setMode(mode);
    }
    try {
      preview = await api('/family-preview?code=' + encodeURIComponent(v));
      hint.innerHTML = '✅ ' + t('Семья «{name}», участников: {n}', { name: esc(preview.name), n: preview.members.length });
      document.getElementById('rel').innerHTML =
        '<option value="">—</option>' + preview.members.map((m) => `<option value="${m.id}">${esc(m.name)} (${esc(roleName(m.role))})</option>`).join('');
    } catch (e) {
      hint.textContent = '❌ ' + e.message;
    }
    setMode(mode);
  };
  codeInput.oninput = () => { clearTimeout(timer); timer = setTimeout(lookup, 350); };
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
    const btn = f.querySelector('button:not([type=button])');
    btn.disabled = true;
    try {
      await api('/register', { method: 'POST', body: { ...formData(f), familyMode: mode, avatar: avatarData, lang: state.lang } });
      await loadMe();
      toast(t('Добро пожаловать, {name}!', { name: state.me.name }));
      go(mode === 'create' ? '/family' : '/');
    } catch (er) {
      showErr(er.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- главная ----------
const TABS = ['voting', 'funding', 'done', 'bought', 'rejected'];

async function renderHome() {
  shell('<div class="spinner"></div>');
  try {
    state.items = await api('/items');
  } catch (e) {
    return toast(e.message, true);
  }
  const counts = Object.fromEntries(TABS.map((s) => [s, 0]));
  state.items.forEach((i) => counts[i.status]++);
  const needMyVote = state.items.filter((i) => i.status === 'voting' && i.creatorId !== state.me.id && i.myVote === null).length;
  const needMyCheck = state.items.filter((i) => i.creatorId === state.me.id && i.pendingCount > 0).reduce((s, i) => s + i.pendingCount, 0);
  const needMyPurchase = state.items.filter((i) => i.creatorId === state.me.id && i.status === 'done').length;
  const todo = [
    needMyVote && t('ждут вашего голоса: {n}', { n: `<b>${needMyVote}</b>` }),
    needMyCheck && t('чеков на проверку: {n}', { n: `<b>${needMyCheck}</b>` }),
    needMyPurchase && t('отметьте покупку: {n}', { n: `<b>${needMyPurchase}</b>` }),
  ].filter(Boolean);
  const list = state.items.filter((i) => i.status === state.tab);

  shell(`
    <div class="family-head">
      <div class="grow">
        <h1>${t('Привет, {name} 👋', { name: esc(state.me.name) })}</h1>
        <p class="muted" style="margin:4px 0 0">${todo.length ? '⚡ ' + todo.join(' · ') : t('Что купим вместе?')}</p>
      </div>
      <a class="stack" href="#/family" title="${t('Семья')}">${state.members.slice(0, 6).map((m) => avatar(m)).join('')}</a>
    </div>
    <div data-install-slot="home">${installBox('home')}</div>
    <div data-push-slot="home"></div>
    ${state.members.length < 2 ? `<div class="note" style="margin-bottom:16px">${t('Вы пока один в семье. <a href="#/family">Пригласите родных</a> — без них голосование не начнётся.')}</div>` : ''}
    <div class="tabs">${TABS.map((s) => `<button class="tab ${s === state.tab ? 'active' : ''}" data-tab="${s}">${STATUS[s].icon} ${t(STATUS[s].label)}<span class="count">${counts[s]}</span></button>`).join('')}</div>
    ${list.length ? `<div class="grid">${list.map(itemCard).join('')}</div>` : `
      <div class="empty"><div class="big">${STATUS[state.tab].icon}</div>
      ${state.tab === 'voting' ? t('Пока никто ничего не предложил.<br>Нажмите «Хочу вещь», чтобы начать.') : t('Здесь пока пусто')}</div>`}
    <button class="fab" onclick="location.hash='#/new'"><span style="font-size:22px">＋</span> ${t('Хочу вещь')}</button>`);

  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderHome(); }));
  bindInstall();
  fillPush();
}

function itemCard(i) {
  const author = member(i.creatorId);
  let extra = '';
  if (i.status === 'voting') {
    const mine = i.creatorId === state.me.id;
    extra = `<div class="money-row"><span>${t('За')}: <b class="vote-yes">${i.yes}</b> · ${t('Против')}: <b class="vote-no">${i.no}</b></span><span class="muted">${t('из {n}', { n: i.votersCount })}</span></div>
      ${!mine && i.myVote === null ? `<div class="note small">${t('Нужен ваш голос')}</div>` : ''}`;
  } else if (i.status === 'funding' || i.status === 'done') {
    extra = `<div class="progress"><div style="width:${pct(i.collected, i.price)}%"></div></div>
      <div class="money-row"><span>${t('Собрано')} <b>${money(i.collected)}</b></span><span class="muted">${pct(i.collected, i.price)}%</span></div>
      ${i.status === 'funding' ? `<div class="money-row"><span class="muted">${t('Осталось')}</span><b>${money(i.remaining)}</b></div>` : ''}
      ${i.pendingCount ? `<div class="note small">⏳ ${t('На проверке: {sum}', { sum: money(i.pendingSum) })}${i.creatorId === state.me.id ? ' — ' + t('проверьте чеки') : ''}</div>` : ''}
      ${i.status === 'done' && i.creatorId === state.me.id ? `<div class="note small">🛍️ ${t('Купили? Отметьте покупку')}</div>` : ''}`;
  } else if (i.status === 'bought' && i.boughtAt) {
    extra = `<div class="muted small">🛍️ ${t('Куплено {date}', { date: dateLong(i.boughtAt) })}</div>`;
  }
  return `<a class="card item-card" href="#/item/${i.id}">
    <div class="item-photo">${i.hasPhoto ? `<img src="/api/items/${i.id}/photo" alt="" loading="lazy">` : '<div class="ph">🎁</div>'}${badge(i.status)}</div>
    <div class="item-body">
      <h3>${esc(i.title)}</h3>
      <div class="price">${money(i.price)}</div>
      ${deadlineChip(i)}
      ${extra}
      <div class="item-meta">${avatar(author, 'sm')}<span>${esc(author?.name || '—')}</span>
        ${i.messageCount ? `<span class="spacer"></span><span>💬 ${i.messageCount}</span>` : ''}</div>
    </div></a>`;
}

// ---------- создание и редактирование вещи ----------
async function renderItemForm(editId) {
  let item = null;
  if (editId) {
    shell('<div class="spinner"></div>');
    try {
      item = await api('/items/' + editId);
    } catch (e) {
      toast(e.message, true);
      return go('/');
    }
    if (item.creatorId !== state.me.id) return go('/item/' + editId);
  }
  // после одобрения семьёй название и сумму менять нельзя
  const locked = item && item.status !== 'voting';
  let photo = null;
  const v = (k, d = '') => esc(item ? item[k] ?? d : d);

  shell(`
    <a class="back" href="${item ? '#/item/' + item.id : '#/'}">← ${t('Назад')}</a>
    <div class="card card-pad" style="max-width:640px;margin:0 auto">
      <h1 style="margin-bottom:6px">${item ? t('Изменить заявку') : t('Хочу вещь')}</h1>
      <p class="muted" style="margin:0 0 18px">${item
        ? (locked ? t('Семья уже одобрила заявку — название и сумму менять нельзя.') : t('Если поменять название или цену, голоса сбросятся и семья проголосует заново.'))
        : t('Семья проголосует, и если все за — начнётся сбор денег.')}</p>
      <form id="f">
        <label class="photo-drop" id="drop"><input type="file" accept="image/*" id="ph">
          ${item && item.hasPhoto ? `<img src="/api/items/${item.id}/photo" alt="">` : `<span>📷<br>${t('Добавить фото')}</span>`}</label>
        <div style="height:14px"></div>
        <div class="field"><label>${t('Что хотите купить')}</label><input class="input" name="title" required maxlength="100" placeholder="${t('Например, велосипед')}" value="${v('title')}" ${locked ? 'disabled' : ''}></div>
        <div class="field"><label>${t('Описание')} <span class="muted">(${t('зачем, ссылка на товар')})</span></label><textarea class="input" name="description" maxlength="1000">${v('description')}</textarea></div>
        <div class="row">
          <div class="field"><label>${t('Цена, ₸')}</label><input class="input" name="price" type="number" inputmode="numeric" min="1" step="1" required value="${v('price')}" ${locked ? 'disabled' : ''}></div>
          <div class="field"><label>${t('Уже есть своих, ₸')}</label><input class="input" name="ownAmount" type="number" inputmode="numeric" min="0" step="1" value="${v('ownAmount', 0)}" ${locked ? 'disabled' : ''}></div>
        </div>
        <div class="row">
          <div class="field"><label>${t('Номер Kaspi для переводов')}</label><input class="input" name="kaspiPhone" type="tel" inputmode="tel" required placeholder="+7 7XX XXX XX XX" value="${item ? v('kaspiPhone') : esc(state.me.kaspiPhone || '')}"></div>
          <div class="field"><label>${t('Имя в Kaspi')} <span class="muted">(${t('необяз.')})</span></label><input class="input" name="kaspiName" maxlength="60" placeholder="Ерлан А." value="${item ? v('kaspiName') : esc(state.me.name)}"></div>
        </div>
        <div class="field"><label>${t('Срок сбора')} <span class="muted">(${t('необязательно')})</span></label>
          <input class="input" name="deadline" type="date" min="${todayKz()}" value="${v('deadline')}">
          <span class="hint">${t('Например, ко дню рождения. За 3 дня до срока всем придёт напоминание.')}</span></div>
        ${locked ? '' : `<div class="note" id="calc" style="margin-bottom:14px"></div>`}
        <button class="btn btn-primary btn-block">${item ? t('Сохранить') : t('Отправить на голосование')}</button>
      </form>
    </div>`);
  const f = document.getElementById('f');
  const calc = () => {
    const el = document.getElementById('calc');
    if (!el) return;
    const d = formData(f);
    el.textContent = t('Нужно собрать: {sum}', { sum: money(Math.max(0, (+d.price || 0) - (+d.ownAmount || 0))) });
  };
  calc();
  f.oninput = calc;
  document.getElementById('ph').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      photo = await resizeImage(file, 1280);
      const drop = document.getElementById('drop');
      drop.querySelector('span')?.remove();
      drop.querySelector('img')?.remove();
      drop.insertAdjacentHTML('beforeend', `<img src="${photo}" alt="">`);
    } catch (er) { toast(er.message, true); }
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    withBusy(f.querySelector('button'), async () => {
      const body = { ...formData(f), photo };
      if (item) {
        const r = await api('/items/' + item.id, { method: 'PUT', body });
        toast(r.votesReset ? t('Сохранено — голоса сброшены, семья проголосует заново') : t('Сохранено'));
        go('/item/' + item.id);
      } else {
        const { id } = await api('/items', { method: 'POST', body });
        state.tab = 'voting';
        state.shareHint = { id, text: t('Заявка создана! Сообщите семье в WhatsApp, чтобы проголосовали.') };
        toast(t('Отправлено на голосование'));
        go('/item/' + id);
      }
    });
  };
}

// ---------- страница вещи ----------
const C_STATUS = {
  pending: () => `<span class="badge badge-voting">⏳ ${t('Проверяется')}</span>`,
  confirmed: () => `<span class="badge badge-done">✅ ${t('Получено')}</span>`,
  rejected: () => `<span class="badge badge-rejected">❌ ${t('Отклонено')}</span>`,
};
const cStatus = (s) => (C_STATUS[s] ? C_STATUS[s]() : '');

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
  const authorName = esc(author?.name || t('автор'));
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
      action = `<div class="note">${t('Это ваша заявка — ждём голосов семьи ({n} из {total}).', { n: i.yes + i.no, total: voters.length })}</div>`;
    } else {
      action = `<h3 style="margin-bottom:10px">${t('Нужна ли эта вещь?')}</h3>
        <div class="vote-btns">
          <button class="btn ${i.myVote === true ? 'btn-ok' : 'btn-ghost'}" data-vote="1">👍 ${t('Нужна')}</button>
          <button class="btn ${i.myVote === false ? 'btn-no' : 'btn-ghost'}" data-vote="0">👎 ${t('Не нужна')}</button>
        </div>
        <p class="muted small" style="margin:8px 0 0">${i.myVote === null ? t('Сбор начнётся, когда все члены семьи одобрят.') : t('Голос можно изменить, пока голосуют остальные.')}</p>`;
    }
  } else if (i.status === 'funding') {
    const kaspi = `
      <div class="kaspi">
        <div class="kaspi-logo">K</div>
        <div class="grow"><div class="muted small">${t('Перевод на Kaspi')}${i.kaspiName ? ' · ' + esc(i.kaspiName) : ''}</div>
          <div class="kaspi-phone">${esc(i.kaspiPhone || t('номер не указан'))}</div></div>
        ${i.kaspiPhone ? `<button type="button" class="btn btn-sm btn-ghost" id="copyKaspi">${t('Копировать')}</button>` : ''}
      </div>
      ${i.kaspiPhone ? `<button type="button" class="btn btn-kaspi btn-block" id="openKaspi" style="margin-top:10px">
        <span class="kaspi-logo sm">K</span> ${t('Перевести в Kaspi')}</button>
        <p class="muted small" style="margin:6px 0 0">${t('Номер скопируется и откроется Kaspi: <b>Переводы → Клиенту Kaspi → По номеру телефона</b> → вставьте номер.')}</p>` : ''}`;
    if (i.available <= 0) {
      action = `${kaspi}<div class="note" style="margin-top:12px">${t('Вся оставшаяся сумма уже отправлена и ждёт подтверждения: {name}.', { name: authorName })}</div>`;
    } else {
      action = `<h3 style="margin-bottom:10px">💚 ${t('Помочь')}</h3>
        ${kaspi}
        <ol class="steps"><li>${t('Скопируйте номер и переведите деньги в приложении Kaspi.')}</li>
          <li>${t('Сделайте скриншот или скачайте чек.')}</li>
          <li>${isMine ? t('Прикрепите чек ниже — взнос засчитается сразу.') : t('Прикрепите чек ниже — {name} проверит и подтвердит.', { name: authorName })}</li></ol>
        <form id="cf">
          ${myRejected ? `<div class="error-box">${t('Ваш перевод {sum} отклонён: «{reason}». Проверьте и отправьте ещё раз.', { sum: money(myRejected.amount), reason: esc(myRejected.rejectReason) })}</div>` : ''}
          <div class="field"><label>${t('Сколько перевели, ₸')}</label><input class="input" name="amount" type="number" inputmode="numeric" min="1" max="${i.available}" step="1" placeholder="${t('Не больше {sum}', { sum: money(i.available) })}" required></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 14px">
            ${[1000, 5000, 10000].filter((v) => v < i.available).map((v) => `<button type="button" class="btn btn-ghost btn-sm" data-q="${v}">${money(v)}</button>`).join('')}
            <button type="button" class="btn btn-ghost btn-sm" data-q="${i.available}">${t('Всё')}: ${money(i.available)}</button>
          </div>
          <label class="receipt-drop" id="rdrop"><input type="file" accept="image/*,application/pdf" id="rfile">
            <span id="rlabel">🧾 ${t('Прикрепить чек (фото или PDF)')}</span></label>
          <div class="field" style="margin-top:14px"><input class="input" name="comment" maxlength="200" placeholder="${t('Комментарий (необязательно)')}"></div>
          <button class="btn btn-primary btn-block">${t('Я перевёл(а) — отправить чек')}</button>
        </form>`;
    }
  } else if (i.status === 'done') {
    action = `<div class="note" style="background:var(--ok-soft);color:var(--ok)">🎉 ${t('Деньги собраны! Можно покупать.')}</div>`;
    if (isMine) {
      action += `<h3 style="margin:16px 0 10px">🛍️ ${t('Отметить покупку')}</h3>
        <form id="bf">
          <label class="receipt-drop" id="bdrop"><input type="file" accept="image/*,application/pdf" id="bfile">
            <span id="blabel">📷 ${t('Фото покупки или чек из магазина')}</span></label>
          <div class="field" style="margin-top:14px"><input class="input" name="note" maxlength="300" placeholder="${t('Пара слов семье (необязательно)')}"></div>
          <button class="btn btn-primary btn-block">${t('Купили!')}</button>
        </form>`;
    } else {
      action += `<p class="muted small" style="margin:8px 0 0">${t('Ждём, когда {name} купит и покажет покупку.', { name: authorName })}</p>`;
    }
  } else if (i.status === 'bought') {
    action = `<div class="bought-box">
      <div><b>🛍️ ${t('Куплено {date}', { date: dateLong(i.boughtAt) })}</b></div>
      ${i.boughtNote ? `<p style="margin:6px 0 0">«${esc(i.boughtNote)}»</p>` : ''}
      ${i.boughtProofType === 'image' ? `<a href="/api/items/${i.id}/bought-proof" target="_blank" rel="noopener"><img class="bought-img" src="/api/items/${i.id}/bought-proof" alt=""></a>` : ''}
      ${i.boughtProofType === 'pdf' ? `<a href="/api/items/${i.id}/bought-proof" target="_blank" rel="noopener">📄 ${t('Чек из магазина (PDF)')}</a>` : ''}
    </div>`;
  } else {
    action = `<div class="note" style="background:var(--no-soft);color:var(--no)">${t('Семья решила, что эта вещь пока не нужна.')}</div>`;
    if (isMine) {
      action += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <a class="btn btn-ghost btn-sm" href="#/edit/${i.id}">✏️ ${t('Изменить')}</a>
        <button class="btn btn-primary btn-sm" id="revote">🔁 ${t('Предложить ещё раз')}</button></div>`;
    }
  }

  const showMoney = ['funding', 'done', 'bought'].includes(i.status);
  const contribRow = (c) => {
    const m = member(c.userId);
    const receipt = c.receiptType
      ? `<a href="/api/contributions/${c.id}/receipt" target="_blank" rel="noopener" class="small">🧾 ${c.receiptType === 'pdf' ? t('Чек (PDF)') : t('Чек')}</a>` : '';
    const review = isMine && c.status === 'pending' ? `
      <div class="review">
        <button class="btn btn-ok btn-sm" data-confirm="${c.id}">✅ ${t('Деньги пришли')}</button>
        <button class="btn btn-ghost btn-sm" data-reject="${c.id}">❌ ${t('Не пришли')}</button>
        <form class="reject-form hidden" data-rform="${c.id}">
          <input class="input" name="reason" maxlength="200" required placeholder="${t('Причина: например, перевода нет в Kaspi')}">
          <button class="btn btn-no btn-sm">${t('Отклонить')}</button>
        </form>
      </div>` : '';
    return `<div class="list-row contrib">${avatar(m)}
      <div class="grow"><div class="name">${esc(m?.name || '—')} · <b>${money(c.amount)}</b></div>
        <div class="contrib-meta">${cStatus(c.status)} ${receipt}
          <button type="button" class="link-btn small" data-discuss="${c.id}">💬 ${t('Обсудить')}</button></div>
        ${c.comment ? `<div class="muted small">${esc(c.comment)}</div>` : ''}
        ${c.status === 'rejected' && c.rejectReason ? `<div class="vote-no small">${t('Причина')}: ${esc(c.rejectReason)}</div>` : ''}
        ${review}</div></div>`;
  };
  const canEdit = isMine && i.status !== 'rejected' && i.status !== 'bought';

  shell(`
    <a class="back" href="#/">← ${t('Все вещи')}</a>
    ${hint ? `<div class="share-hint"><span>${esc(hint.text)}</span><a class="btn btn-wa" href="${waLink(i)}" target="_blank" rel="noopener">📲 WhatsApp</a></div>` : ''}
    <div class="detail">
      <div>
        <div class="detail-photo">${i.hasPhoto ? `<img src="/api/items/${i.id}/photo" alt="">` : '<div class="ph">🎁</div>'}</div>
        ${i.description ? `<div class="card card-pad section"><h3 style="margin-bottom:6px">${t('Описание')}</h3><p style="margin:0;white-space:pre-wrap">${esc(i.description)}</p></div>` : ''}
      </div>
      <div>
        <div class="card card-pad">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            ${badge(i.status)}
            <div style="display:flex;gap:6px">
              ${canEdit ? `<a class="btn btn-ghost btn-sm" href="#/edit/${i.id}">✏️ ${t('Изменить')}</a>` : ''}
              <a class="btn btn-wa btn-sm" href="${waLink(i)}" target="_blank" rel="noopener">📲 WhatsApp</a>
            </div>
          </div>
          <h1 style="margin:10px 0 4px">${esc(i.title)}</h1>
          <div class="item-meta">${avatar(author, 'sm')}<span>${esc(author?.name || '—')} · ${esc(roleName(author?.role || ''))}</span></div>
          ${deadlineChip(i) ? `<div style="margin-top:8px">${deadlineChip(i)}</div>` : ''}
          <div class="stats">
            <div class="stat"><div class="label">${t('Цена')}</div><div class="val">${money(i.price)}</div></div>
            <div class="stat"><div class="label">${t('Собрано')}</div><div class="val">${money(i.collected)}</div></div>
            <div class="stat"><div class="label">${t('Осталось')}</div><div class="val">${money(i.remaining)}</div></div>
          </div>
          ${showMoney ? `<div class="progress">
              <div style="width:${pct(i.collected, i.price)}%"></div>
              <div class="pending-bar" style="width:${pct(i.pendingSum, i.price)}%"></div></div>
            <p class="muted small" style="margin:6px 0 16px">${pct(i.collected, i.price)}% · ${t('своих у автора {sum}', { sum: money(i.ownAmount) })}${i.pendingSum ? ' · ⏳ ' + t('на проверке {sum}', { sum: money(i.pendingSum) }) : ''}</p>` : ''}
          ${action}
          ${isMine && i.contribCount === 0 ? `<button class="btn btn-ghost btn-sm" id="del" style="margin-top:14px">${t('Удалить заявку')}</button>` : ''}
        </div>

        ${showMoney ? `<div class="card card-pad section">
          <h3>${t('Переводы')}${isMine && i.pendingCount ? ` <span class="badge badge-voting">${t('проверьте: {n}', { n: i.pendingCount })}</span>` : ''}</h3>
          <div class="list">${i.contributions.length ? i.contributions.map(contribRow).join('') : `<p class="muted">${t('Пока никто не перевёл — будьте первым!')}</p>`}</div>
        </div>` : ''}

        <div class="card card-pad section" id="chat">
          <h3>💬 ${t('Обсуждение')}</h3>
          <div class="chat-list" id="chatList"></div>
          <form class="chat-form" id="chatForm">
            <div id="replyChip"></div>
            <div class="chat-input">
              <textarea class="input" name="text" rows="1" maxlength="1000" placeholder="${t('Написать семье…')}" required></textarea>
              <button class="btn btn-primary" title="${t('Отправить')}">➤</button>
            </div>
          </form>
        </div>

        <div class="card card-pad section">
          <h3>${t('Голоса семьи')}</h3>
          <div class="list">${voters.length ? voters.map((m) => {
            const v = voteOf(m.id);
            const st = v ? (v.approve ? `<span class="vote-yes">👍 ${t('За')}</span>` : `<span class="vote-no">👎 ${t('Против')}</span>`) : `<span class="vote-wait">⏳ ${t('Ждём')}</span>`;
            return `<div class="list-row">${avatar(m)}<div class="grow"><div class="name">${esc(m.name)}</div><div class="muted small">${roleLine(m)}</div></div>${st}</div>`;
          }).join('') : `<p class="muted">${t('В семье пока больше никого нет')}</p>`}</div>
        </div>
      </div>
    </div>`);

  setupChat(i, opts);

  document.querySelectorAll('[data-vote]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const r = await api(`/items/${id}/vote`, { method: 'POST', body: { approve: b.dataset.vote === '1' } });
    toast(t('Голос учтён'));
    if (r.status === 'funding') state.shareHint = { id, text: t('Все одобрили — сбор начался! Сообщите семье в WhatsApp.') };
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
  if (copy) copy.onclick = async () => toast((await copyPhone()) ? t('Номер скопирован: {phone}', { phone: i.kaspiPhone }) : i.kaspiPhone);
  const open = document.getElementById('openKaspi');
  if (open) {
    open.onclick = async () => {
      const copied = await copyPhone();
      const link = kaspiAppLink();
      if (!link) return toast(t('Откройте Kaspi на телефоне: Переводы → Клиенту Kaspi → {phone}', { phone: i.kaspiPhone }));
      toast(copied ? t('Номер скопирован — открываем Kaspi…') : t('Открываем Kaspi… Номер: {phone}', { phone: i.kaspiPhone }));
      setTimeout(() => (location.href = link), 500);
    };
  }

  const cf = document.getElementById('cf');
  if (cf) {
    if (myRejected) cf.elements.amount.value = Math.min(myRejected.amount, i.available);
    cf.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => (cf.elements.amount.value = b.dataset.q)));
    const getReceipt = bindDocDrop('rdrop', 'rfile', 'rlabel', t('✅ Чек прикреплён — нажмите, чтобы заменить'));
    cf.onsubmit = (e) => {
      e.preventDefault();
      const receipt = getReceipt();
      if (!receipt) return toast(t('Прикрепите чек перевода'), true);
      withBusy(cf.querySelector('button:not([type=button])'), async () => {
        const r = await api(`/items/${id}/contribute`, { method: 'POST', body: { ...formData(cf), receipt } });
        toast(r.status === 'pending' ? t('Чек отправлен — ждём подтверждения 💚') : t('Взнос засчитан 💚'));
        state.shareHint = { id, text: t('Спасибо! Напишите семье в WhatsApp, сколько осталось собрать.') };
        renderItem(id);
      });
    };
  }

  const bf = document.getElementById('bf');
  if (bf) {
    const getProof = bindDocDrop('bdrop', 'bfile', 'blabel', t('✅ Файл прикреплён — нажмите, чтобы заменить'));
    bf.onsubmit = (e) => {
      e.preventDefault();
      const proof = getProof();
      if (!proof) return toast(t('Прикрепите фото покупки или чек'), true);
      withBusy(bf.querySelector('button'), async () => {
        await api(`/items/${id}/bought`, { method: 'POST', body: { ...formData(bf), proof } });
        toast(t('Покупка отмечена 🛍️'));
        state.shareHint = { id, text: t('Покажите покупку семье в WhatsApp!') };
        renderItem(id);
      });
    };
  }

  const revote = document.getElementById('revote');
  if (revote) {
    revote.onclick = () => withBusy(revote, async () => {
      await api(`/items/${id}/revote`, { method: 'POST' });
      toast(t('Заявка снова на голосовании'));
      state.shareHint = { id, text: t('Заявка снова на голосовании — напишите семье в WhatsApp.') };
      renderItem(id);
    });
  }

  document.querySelectorAll('[data-confirm]').forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const r = await api(`/contributions/${b.dataset.confirm}/confirm`, { method: 'POST' });
    toast(t('Взнос подтверждён ✅'));
    if (r.status === 'done') state.shareHint = { id, text: t('🎉 Всё собрано! Обрадуйте семью в WhatsApp.') };
    renderItem(id);
  })));
  document.querySelectorAll('[data-reject]').forEach((b) => (b.onclick = () => {
    const form = document.querySelector(`[data-rform="${b.dataset.reject}"]`);
    form.classList.toggle('hidden');
    form.elements.reason.focus();
  }));
  document.querySelectorAll('[data-rform]').forEach((form) => (form.onsubmit = (e) => {
    e.preventDefault();
    withBusy(form.querySelector('button'), async () => {
      await api(`/contributions/${form.dataset.rform}/reject`, { method: 'POST', body: formData(form) });
      toast(t('Взнос отклонён — сумма снова доступна для сбора'));
      renderItem(id);
    });
  }));

  const del = document.getElementById('del');
  if (del) {
    armed(del, t('Точно удалить? Нажмите ещё раз'), async () => {
      await api('/items/' + id, { method: 'DELETE' });
      toast(t('Заявка удалена'));
      go('/');
    });
  }
}

// ---------- обсуждение вещи ----------
function chatTime(v) {
  const d = parseTime(v);
  const hm = d.toLocaleTimeString(LOCALE(), { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString(LOCALE(), { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

function quoteHtml(c) {
  if (!c) return '';
  const who = member(c.userId);
  return `<div class="chat-quote">↪ ${esc(who?.name || '—')} · ${money(c.amount)}${c.status ? ' ' + cStatus(c.status) : ''}</div>`;
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
      <div class="msg-meta">${chatTime(m.at)}${mine ? ` · <button type="button" class="link-btn" data-mdel="${m.id}">${t('удалить')}</button>` : ''}</div>
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
  list.innerHTML = `<p class="muted chat-empty">${t('Пока тихо. Спросите, уточните, поблагодарите — все увидят и получат уведомление.')}</p>`;
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
    form.elements.text.focus({ preventScroll: true });
  }));

  const ta = form.elements.text;
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
      del.textContent = t('точно удалить?');
      return;
    }
    withBusy(del, async () => {
      await api('/messages/' + del.dataset.mdel, { method: 'DELETE' });
      list.querySelector(`[data-mid="${del.dataset.mdel}"]`)?.remove();
    });
  };

  if (opts.chat) setTimeout(() => document.getElementById('chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

// ---------- семья и профиль ----------
async function renderFamily() {
  await loadMe();
  let avatarData;
  const owner = isOwner();
  const link = `${location.origin}/#/join/${state.family.inviteCode}`;
  const roleOpts = state.roles.map((r) => `<option value="${esc(r)}" ${r === state.me.role ? 'selected' : ''}>${esc(roleName(r))}</option>`).join('');
  const relOpts = state.members.filter((m) => m.id !== state.me.id)
    .map((m) => `<option value="${m.id}" ${m.id === state.me.relationTo ? 'selected' : ''}>${esc(m.name)} (${esc(roleName(m.role))})</option>`).join('');

  const memberRow = (m) => {
    const isHead = m.id === state.family.ownerId;
    const actions = owner && m.id !== state.me.id ? `
      <div class="member-actions hidden" data-actions="${m.id}">
        <button class="btn btn-ghost btn-sm" data-make-owner="${m.id}">👑 ${t('Сделать главой')}</button>
        <button class="btn btn-ghost btn-sm" data-remove="${m.id}">${t('Исключить из семьи')}</button>
      </div>` : '';
    return `<div class="list-row member-row">${avatar(m)}
      <div class="grow"><div class="name">${esc(m.name)}${isHead ? ' 👑' : ''}${m.id === state.me.id ? ` <span class="muted small">(${t('вы')})</span>` : ''}</div>
        <div class="muted small">${roleLine(m)}${isHead ? ' · ' + t('глава семьи') : ''}</div>${actions}</div>
      ${owner && m.id !== state.me.id ? `<button class="icon-btn" data-more="${m.id}" title="${t('Действия')}">⋯</button>` : ''}
    </div>`;
  };

  shell(`
    <a class="back" href="#/">← ${t('Назад')}</a>
    <div class="detail">
      <div>
        <div class="card card-pad">
          <h2 style="margin-bottom:12px">${t('Пригласить в семью')}</h2>
          <div class="invite">
            <div style="flex:1;min-width:160px"><div class="muted small">${t('Код семьи')}</div><code>${esc(state.family.inviteCode)}</code></div>
            <button class="btn btn-primary" id="share">${t('Поделиться ссылкой')}</button>
          </div>
          <p class="muted small" style="margin:10px 0 0">${t('Отправьте ссылку в WhatsApp или Telegram — по ней сразу откроется регистрация в вашу семью.')}</p>
          ${owner ? `<button class="link-btn small" id="regen" style="margin-top:8px">🔄 ${t('Сменить код (старая ссылка перестанет работать)')}</button>` : ''}
        </div>
        <div class="card card-pad section">
          <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
            <h2>${t('Семья «{name}»', { name: esc(state.family.name) })}</h2>
            ${owner ? `<button class="icon-btn" id="renameBtn" title="${t('Переименовать')}">✏️</button>` : ''}
          </div>
          ${owner ? `<form id="renameForm" class="hidden rename-form"><input class="input" name="name" maxlength="60" value="${esc(state.family.name)}" required><button class="btn btn-primary btn-sm">${t('Сохранить')}</button></form>` : ''}
          <div class="list">${state.members.map(memberRow).join('')}</div>
          ${owner ? `<p class="muted small" style="margin:8px 0 0">${t('Вы глава семьи: можете исключить участника, сменить код приглашения или передать главенство.')}</p>` : ''}
        </div>
      </div>
      <div>
        <form class="card card-pad" id="pf">
          <h2 style="margin-bottom:14px">${t('Мой профиль')}</h2>
          <div class="avatar-picker">
            <span id="av">${avatar(state.me, 'lg')}</span>
            <label class="file-label btn btn-ghost btn-sm">${t('Сменить фото')}<input type="file" accept="image/*" id="avFile"></label>
          </div>
          <div class="field"><label>${t('Имя')}</label><input class="input" name="name" value="${esc(state.me.name)}" required maxlength="60"></div>
          <div class="field"><label>${t('Кто вы в семье')}</label><select class="input" name="role">${roleOpts}</select></div>
          <div class="field"><label>${t('Кому вы приходитесь')}</label><select class="input" name="relationTo"><option value="">—</option>${relOpts}</select></div>
          <div class="field"><label>${t('Мой номер Kaspi')}</label><input class="input" name="kaspiPhone" type="tel" inputmode="tel" placeholder="+7 7XX XXX XX XX" value="${esc(state.me.kaspiPhone || '')}">
            <span class="hint">${t('Подставится, когда вы создаёте вещь')}</span></div>
          <div class="field"><label>${t('Язык')}</label>
            <div class="segmented" style="margin:0">
              <button type="button" data-lang="ru" class="${state.lang === 'ru' ? 'active' : ''}">Русский</button>
              <button type="button" data-lang="kk" class="${state.lang === 'kk' ? 'active' : ''}">Қазақша</button>
            </div></div>
          <label class="check"><input type="checkbox" name="notifyEmail" ${state.me.notifyEmail ? 'checked' : ''}>
            <span>${t('Присылать письма на {email}', { email: esc(state.me.email) })}<br><span class="muted small">${t('новые вещи, голоса, переводы, напоминания')}${state.mailEnabled ? '' : ' · ' + t('отправка писем на сайте пока не настроена')}</span></span></label>
          <button class="btn btn-primary btn-block">${t('Сохранить')}</button>
        </form>

        <form class="card card-pad section" id="pwf">
          <h2 style="margin-bottom:14px">${t('Пароль и вход')}</h2>
          <div class="field"><label>${t('Текущий пароль')}</label><input class="input" name="current" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>${t('Новый пароль')}</label><input class="input" name="password" type="password" minlength="6" autocomplete="new-password" required>
            <span class="hint">${t('После смены пароля другие устройства выйдут из аккаунта')}</span></div>
          <button class="btn btn-primary btn-block">${t('Сменить пароль')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="logoutAll" style="margin-top:10px">${t('Выйти на всех устройствах')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="logout" style="margin-top:10px">${t('Выйти')}</button>
        </form>
        <div class="section" data-install-slot="profile">${installBox('profile')}</div>
        <div class="section" data-push-slot="profile"></div>
      </div>
    </div>`);

  document.getElementById('share').onclick = async () => {
    const text = t('Присоединяйся к нашей семье «{name}»: {link}', { name: state.family.name, link });
    if (navigator.share) {
      try { await navigator.share({ title: 'Отбасы Қоры', text, url: link }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(link); toast(t('Ссылка скопирована')); } catch { toast(link); }
    }
  };

  // --- действия главы семьи
  const regen = document.getElementById('regen');
  if (regen) {
    armed(regen, t('Точно сменить код? Нажмите ещё раз'), async () => {
      await api('/family/invite-code', { method: 'POST' });
      toast(t('Новый код создан'));
      renderFamily();
    });
  }
  const renameBtn = document.getElementById('renameBtn');
  if (renameBtn) {
    const rf = document.getElementById('renameForm');
    renameBtn.onclick = () => rf.classList.toggle('hidden');
    rf.onsubmit = (e) => {
      e.preventDefault();
      withBusy(rf.querySelector('button'), async () => {
        await api('/family', { method: 'PUT', body: formData(rf) });
        toast(t('Сохранено'));
        renderFamily();
      });
    };
  }
  document.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => {
    document.querySelector(`[data-actions="${b.dataset.more}"]`).classList.toggle('hidden');
  }));
  document.querySelectorAll('[data-make-owner]').forEach((b) => {
    const m = member(Number(b.dataset.makeOwner));
    armed(b, t('Передать главенство {name}? Нажмите ещё раз', { name: m.name }), async () => {
      await api('/family/owner', { method: 'POST', body: { userId: m.id } });
      toast(t('Теперь глава семьи — {name}', { name: m.name }));
      renderFamily();
    });
  });
  document.querySelectorAll('[data-remove]').forEach((b) => {
    const m = member(Number(b.dataset.remove));
    armed(b, t('Исключить {name}? Нажмите ещё раз', { name: m.name }), async () => {
      await api(`/family/members/${m.id}/remove`, { method: 'POST' });
      toast(t('{name} больше не в семье', { name: m.name }));
      renderFamily();
    });
  });

  // --- профиль
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
      body.notifyEmail = pf.elements.notifyEmail.checked;
      if (avatarData) body.avatar = avatarData;
      await api('/me', { method: 'PUT', body });
      toast(t('Профиль сохранён'));
      renderFamily();
    });
  };

  // --- пароль и выход
  const pwf = document.getElementById('pwf');
  pwf.onsubmit = (e) => {
    e.preventDefault();
    withBusy(pwf.querySelector('button:not([type=button])'), async () => {
      await api('/me/password', { method: 'PUT', body: formData(pwf) });
      pwf.reset();
      toast(t('Пароль изменён'));
    });
  };
  const unsubscribeDevice = async () => {
    // отвязываем это устройство от аккаунта, чтобы чужие уведомления сюда не приходили
    try {
      const sub = await currentSub();
      if (sub) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    } catch {}
    pushSynced = false;
  };
  armed(document.getElementById('logoutAll'), t('Выйти везде? Нажмите ещё раз'), async () => {
    await api('/logout-all', { method: 'POST' });
    pushSynced = false;
    state.me = null;
    go('/login');
  });
  document.getElementById('logout').onclick = async () => {
    await unsubscribeDevice();
    await api('/logout', { method: 'POST' });
    state.me = null;
    go('/login');
  };
  bindInstall();
  fillPush();
}

// ---------- статистика ----------
async function renderStats() {
  shell('<div class="spinner"></div>');
  let s;
  try {
    s = await api('/stats');
  } catch (e) {
    return toast(e.message, true);
  }
  const maxPerson = Math.max(1, ...s.people.map((p) => p.sum));
  const maxMonth = Math.max(1, ...s.months.map((m) => m.sum));
  const monthLabel = (key) => new Date(key + '-01T00:00:00Z').toLocaleDateString(LOCALE(), { month: 'short', timeZone: 'UTC' });
  const monthFull = (key) => new Date(key + '-01T00:00:00Z').toLocaleDateString(LOCALE(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const best = s.months.reduce((a, m) => (m.sum > a.sum ? m : a), s.months[0]);

  shell(`
    <a class="back" href="#/">← ${t('Назад')}</a>
    <h1 style="margin-bottom:16px">📊 ${t('Статистика семьи')}</h1>
    <div class="kpis">
      <div class="kpi"><div class="label">${t('Собрано всего')}</div><div class="kpi-val">${money(s.total)}</div></div>
      <div class="kpi"><div class="label">${t('Куплено вещей')}</div><div class="kpi-val">${s.counts.bought}</div></div>
      <div class="kpi"><div class="label">${t('Идёт сбор')}</div><div class="kpi-val">${s.counts.funding}</div></div>
      <div class="kpi"><div class="label">${t('На голосовании')}</div><div class="kpi-val">${s.counts.voting}</div></div>
    </div>

    <div class="detail">
      <div class="card card-pad">
        <h3>${t('Кто сколько помог')}</h3>
        <p class="muted small" style="margin:4px 0 12px">${t('Подтверждённые переводы за всё время')}</p>
        ${s.people.length ? `<div class="hbars">${s.people.map((p) => {
          const m = member(p.userId);
          return `<div class="hbar" title="${esc(m?.name || '—')}: ${money(p.sum)} · ${t('переводов: {n}', { n: p.count })}">
            <div class="hbar-head">${avatar(m, 'sm')}<span class="name">${esc(m?.name || '—')}${m?.former ? ` <span class="muted small">(${t('бывший участник')})</span>` : ''}</span><span class="spacer"></span><b>${money(p.sum)}</b></div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, (p.sum / maxPerson) * 100)}%"></div></div>
          </div>`;
        }).join('')}</div>` : `<p class="muted">${t('Пока нет подтверждённых переводов')}</p>`}
      </div>

      <div class="card card-pad">
        <h3>${t('Сборы по месяцам')}</h3>
        <p class="muted small" style="margin:4px 0 12px">${best.sum ? t('Больше всего — {month}: {sum}', { month: monthFull(best.month), sum: money(best.sum) }) : t('За последний год переводов не было')}</p>
        <div class="vbars" role="img" aria-label="${t('Сборы по месяцам')}">
          ${s.months.map((m) => `<div class="vbar" tabindex="0" data-tip="${monthFull(m.month)}: ${money(m.sum)}">
            <div class="vbar-track"><div class="vbar-fill" style="height:${m.sum ? Math.max(3, (m.sum / maxMonth) * 100) : 0}%"></div></div>
            <div class="vbar-label">${monthLabel(m.month)}</div></div>`).join('')}
        </div>
        <div class="vbar-tip" id="vtip"></div>
        <details class="table-view"><summary class="small">${t('Показать таблицей')}</summary>
          <table>${s.months.slice().reverse().map((m) => `<tr><td>${monthFull(m.month)}</td><td>${money(m.sum)}</td></tr>`).join('')}</table>
        </details>
      </div>
    </div>

    <div class="card card-pad section">
      <h3>${t('История покупок')}</h3>
      <div class="list">${s.history.length ? s.history.map((h) => {
        const m = member(h.creatorId);
        return `<a class="list-row" href="#/item/${h.id}" style="color:inherit">
          <div class="grow"><div class="name">${esc(h.title)}</div>
            <div class="muted small">${esc(m?.name || '—')} · ${h.status === 'bought' && h.boughtAt ? t('Куплено {date}', { date: dateLong(h.boughtAt) }) : t('Собрано, ещё не куплено')}</div></div>
          <b>${money(h.price)}</b></a>`;
      }).join('') : `<p class="muted">${t('Пока ничего не куплено')}</p>`}</div>
    </div>`);

  // подсказка при наведении/нажатии на столбец
  const tip = document.getElementById('vtip');
  document.querySelectorAll('.vbar').forEach((b) => {
    const show = () => {
      tip.textContent = b.dataset.tip;
      tip.classList.add('show');
    };
    b.onmouseenter = show;
    b.onfocus = show;
    b.onclick = show;
    b.onmouseleave = () => tip.classList.remove('show');
  });
}

route();
