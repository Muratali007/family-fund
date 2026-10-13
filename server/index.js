const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db'); // первым — он подгружает .env.local
const mail = require('./mail');
const push = require('./push');
const { als, norm, t, tpl, fmt, LANGS } = require('./i18n');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// Без JWT_SECRET (локально) — случайный ключ на каждый запуск; в репозитории секретов нет
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET не задан — задайте переменную окружения в продакшене');
  process.exit(1);
}

const ROLES = [
  'Отец', 'Мать', 'Муж', 'Жена', 'Сын', 'Дочь', 'Ребёнок',
  'Брат (аға)', 'Братишка (іні)', 'Сестра (әпке)', 'Сестрёнка (сіңлі)',
  'Келін', 'Күйеу бала (зять)', 'Дедушка (ата)', 'Бабушка (әже)',
  'Внук / внучка (немере)', 'Другое',
];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '7mb' }));
app.use(cookieParser());

// index.html со ссылками вида /app.js?v=<версия>, чтобы после деплоя браузеры сразу брали новые файлы
const VERSION = (process.env.RENDER_GIT_COMMIT || Date.now().toString(36)).slice(0, 12);
const INDEX_HTML = require('fs')
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/(href="\/styles\.css|src="\/(?:app|i18n)\.js)"/g, `$1?v=${VERSION}"`);
const sendIndex = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);

// язык ответа (ошибок) — из заголовка X-Lang, который шлёт фронтенд
app.use('/api', (req, res, next) => {
  res.set('X-App-Version', VERSION);
  als.run({ lang: norm(req.get('X-Lang')) }, next);
});

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg, vars) => new HttpError(400, t(msg, vars));
const notFound = () => new HttpError(404, t('Не найдено'));
const forbidden = (msg) => new HttpError(403, t(msg));

const IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DOC_RE = /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
function checkFile(dataUrl, maxBytes, re = IMG_RE, err = 'Неверный формат изображения') {
  if (dataUrl == null || dataUrl === '') return null;
  if (typeof dataUrl !== 'string' || !re.test(dataUrl)) throw bad(err);
  if (dataUrl.length * 0.75 > maxBytes) throw bad('Файл слишком большой');
  return dataUrl;
}
const checkImage = (d, max) => checkFile(d, max);

function toMoney(v, field) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw bad('Некорректное значение: {f}', { f: t(field) });
  return n;
}

function str(v, field, { min = 0, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw bad('Заполните поле: {f}', { f: t(field) });
  if (s.length > max) throw bad('Слишком длинное поле: {f}', { f: t(field) });
  return s;
}

// +7 707 123 45 67 из любых вариантов записи казахстанского номера
function kzPhone(v, required) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) {
    if (required) throw bad('Укажите номер Kaspi');
    return null;
  }
  const n = d.length === 11 && /^[78]/.test(d) ? d.slice(1) : d.length === 10 ? d : null;
  if (!n) throw bad('Номер Kaspi: формат +7 7XX XXX XX XX');
  return `+7 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 8)} ${n.slice(8)}`;
}

// сегодняшняя дата в Казахстане (UTC+5)
const todayKz = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
function deadlineOf(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('Некорректная дата');
  if (s < todayKz()) throw bad('Срок не может быть в прошлом');
  return s;
}
const ddmm = (s) => (s ? s.split('-').reverse().join('.') : '');
// Postgres отдаёт Date, SQLite — строку "YYYY-MM-DD HH:MM:SS" в UTC
const toDate = (v) => (v instanceof Date ? v : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z'));
const nowSql = () => (db.kind === 'postgres' ? 'NOW()' : "datetime('now')");

function genInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
async function uniqueInviteCode() {
  let code;
  do code = genInviteCode();
  while (await db.get('SELECT id FROM families WHERE invite_code = ?', [code]));
  return code;
}

// Простое ограничение частоты запросов (в памяти процесса)
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) {
    h = { n: 0, reset: now + windowMs };
    hits.set(key, h);
  }
  h.n++;
  if (h.n > max) throw new HttpError(429, t('Слишком много попыток. Попробуйте через {m} мин.', { m: Math.ceil((h.reset - now) / 60000) }));
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 10 * 60e3).unref();

function setAuthCookie(res, userId, version) {
  const token = jwt.sign({ uid: userId, v: version || 0 }, JWT_SECRET, { expiresIn: '60d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 60 * 24 * 3600 * 1000,
  });
}

const auth = wrap(async (req, res, next) => {
  try {
    const { uid, v } = jwt.verify(req.cookies.token || '', JWT_SECRET);
    const user = await db.get(
      'SELECT id, family_id, name, email, role, relation_to, session_version, lang FROM users WHERE id = ?',
      [uid]
    );
    if (!user || Number(user.session_version) !== Number(v || 0)) throw new Error();
    req.user = user;
  } catch {
    throw new HttpError(401, t('Требуется вход'));
  }
  next();
});

async function loadFamily(id) {
  return db.get('SELECT id, name, invite_code, owner_id FROM families WHERE id = ?', [id]);
}
async function requireOwner(req) {
  const fam = await loadFamily(req.user.family_id);
  if (Number(fam.owner_id) !== req.user.id) throw forbidden('Это может сделать только глава семьи');
  return fam;
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    relationTo: u.relation_to,
    hasAvatar: !!Number(u.has_avatar),
  };
}

// ---------- уведомления ----------
const unhtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
const baseUrl = (req) => process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
const itemLink = (req, id) => `${baseUrl(req)}/#/item/${id}`;

const RCPT = 'id, name, email, notify_email, lang';
const familyPeople = (familyId) => db.all(`SELECT ${RCPT} FROM users WHERE family_id = ?`, [familyId]);
const person = (id) => db.get(`SELECT ${RCPT} FROM users WHERE id = ?`, [id]);

// Письмо + push по шаблону key, на языке каждого получателя
function notify(recipients, key, vars, url, { force = false, pushOnly = false } = {}) {
  const v = { ...vars };
  for (const [k, val] of Object.entries(vars)) if (typeof val === 'string') v[k + 'H'] = mail.esc(val);
  const groups = new Map();
  for (const r of recipients.filter(Boolean)) {
    const l = norm(r.lang);
    groups.set(l, [...(groups.get(l) || []), r]);
  }
  for (const [lang, list] of groups) {
    const n = tpl(lang)[key](v);
    if (!pushOnly) mail.notify(list, n.subject, { lines: n.lines || [], url, button: n.button, footer: tpl(lang).footer }, { force });
    if (!force) {
      push.send(list.map((r) => r.id), {
        title: n.subject,
        body: n.body || unhtml((n.lines || []).filter(Boolean).join(' ')).slice(0, 240),
        url,
      });
    }
  }
}

async function notifyStatusChange(req, itemId, to) {
  const item = await db.get('SELECT id, family_id, creator_id, title, price, own_amount, kaspi_phone, kaspi_name FROM items WHERE id = ?', [itemId]);
  const creator = await person(item.creator_id);
  const all = await familyPeople(item.family_id);
  const link = itemLink(req, item.id);
  if (to === 'funding') {
    notify(all, 'funding', {
      title: item.title,
      need: Number(item.price) - Number(item.own_amount),
      phone: item.kaspi_phone || '—',
      kname: item.kaspi_name || creator?.name || '',
    }, link);
  } else if (to === 'rejected') {
    notify([creator], 'rejected', { title: item.title }, link);
  } else if (to === 'done') {
    notify(all, 'done', { title: item.title, price: Number(item.price) }, link);
  }
}

// Пересчёт статуса вещи после голосования / подтверждения взноса. Возвращает новый статус, если он сменился.
async function recalcStatus(itemId) {
  const item = await db.get('SELECT * FROM items WHERE id = ?', [itemId]);
  if (!item) return null;
  if (item.status === 'voting') {
    const voters = await db.all('SELECT id FROM users WHERE family_id = ? AND id <> ?', [item.family_id, item.creator_id]);
    if (voters.length === 0) return null;
    const votes = await db.all('SELECT user_id, approve FROM votes WHERE item_id = ?', [itemId]);
    const byUser = new Map(votes.map((v) => [v.user_id, Number(v.approve)]));
    if (!voters.every((v) => byUser.has(v.id))) return null;
    const allYes = voters.every((v) => byUser.get(v.id) === 1);
    await db.run('UPDATE items SET status = ? WHERE id = ?', [allYes ? 'funding' : 'rejected', itemId]);
    return allYes ? (await recalcStatus(itemId)) || 'funding' : 'rejected';
  }
  if (item.status === 'funding') {
    const { s } = await db.get(
      "SELECT COALESCE(SUM(amount), 0) AS s FROM contributions WHERE item_id = ? AND status = 'confirmed'",
      [itemId]
    );
    if (Number(s) + Number(item.own_amount) >= Number(item.price)) {
      await db.run("UPDATE items SET status = 'done' WHERE id = ?", [itemId]);
      return 'done';
    }
  }
  return null;
}

const docType = (col) => `CASE WHEN ${col} IS NULL THEN NULL WHEN ${col} LIKE 'data:application/pdf%' THEN 'pdf' ELSE 'image' END`;
const ITEM_COLS = `i.id, i.family_id, i.creator_id, i.title, i.description, i.price, i.own_amount, i.status, i.created_at,
  i.kaspi_phone, i.kaspi_name, i.deadline, i.bought_at, i.bought_note,
  ${docType('i.bought_proof')} AS bought_proof_type,
  CASE WHEN i.photo IS NULL THEN 0 ELSE 1 END AS has_photo,
  (SELECT COALESCE(SUM(amount), 0) FROM contributions c WHERE c.item_id = i.id AND c.status = 'confirmed') AS collected,
  (SELECT COALESCE(SUM(amount), 0) FROM contributions c WHERE c.item_id = i.id AND c.status = 'pending') AS pending_sum,
  (SELECT COUNT(*) FROM contributions c WHERE c.item_id = i.id AND c.status = 'pending') AS pending_count,
  (SELECT COUNT(*) FROM contributions c WHERE c.item_id = i.id) AS contrib_count,
  (SELECT COUNT(*) FROM messages m WHERE m.item_id = i.id) AS msg_count,
  (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 1) AS yes_count,
  (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 0) AS no_count`;

async function loadItem(id, familyId) {
  const item = await db.get(`SELECT ${ITEM_COLS} FROM items i WHERE i.id = ? AND i.family_id = ?`, [id, familyId]);
  if (!item) throw notFound();
  return item;
}

function shapeItem(i, votersCount, myVote) {
  const collected = Number(i.collected) + Number(i.own_amount);
  const remaining = Math.max(0, Number(i.price) - collected);
  return {
    id: i.id,
    creatorId: i.creator_id,
    title: i.title,
    description: i.description,
    hasPhoto: !!Number(i.has_photo),
    price: Number(i.price),
    ownAmount: Number(i.own_amount),
    contributed: Number(i.collected),
    collected,
    remaining,
    pendingSum: Number(i.pending_sum),
    pendingCount: Number(i.pending_count),
    // сколько ещё можно отправить, с учётом взносов на проверке
    available: Math.max(0, remaining - Number(i.pending_sum)),
    contribCount: Number(i.contrib_count),
    messageCount: Number(i.msg_count || 0),
    kaspiPhone: i.kaspi_phone,
    kaspiName: i.kaspi_name,
    deadline: i.deadline,
    boughtAt: i.bought_at,
    boughtNote: i.bought_note,
    boughtProofType: i.bought_proof_type,
    status: i.status,
    yes: Number(i.yes_count),
    no: Number(i.no_count),
    votersCount,
    myVote: myVote == null ? null : !!Number(myVote),
    createdAt: i.created_at,
  };
}

function sendDataUrl(req, res, dataUrl) {
  if (!dataUrl) return res.status(404).end();
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return res.status(404).end();
  const buf = Buffer.from(m[2], 'base64');
  const etag = '"' + crypto.createHash('md5').update(buf).digest('hex') + '"';
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', etag);
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type(m[1]).send(buf);
}

// ---------- регистрация и вход ----------
app.get('/api/roles', (req, res) => res.json(ROLES));

app.get('/api/family-preview', wrap(async (req, res) => {
  limit(`preview:${req.ip}`, 60, 15 * 60e3);
  const code = String(req.query.code || '').trim().toUpperCase();
  const fam = await db.get('SELECT id, name FROM families WHERE invite_code = ?', [code]);
  if (!fam) throw new HttpError(404, t('Семья с таким кодом не найдена'));
  const members = await db.all('SELECT id, name, role FROM users WHERE family_id = ? ORDER BY id', [fam.id]);
  res.json({ name: fam.name, members });
}));

app.post('/api/register', wrap(async (req, res) => {
  limit(`register:${req.ip}`, 10, 60 * 60e3);
  const b = req.body || {};
  const name = str(b.name, 'Имя', { min: 2, max: 60 });
  const email = str(b.email, 'Email', { min: 3, max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Некорректный email');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 6) throw bad('Пароль должен быть не короче 6 символов');
  if (!ROLES.includes(b.role)) throw bad('Выберите, кто вы в семье');
  const avatar = checkImage(b.avatar, 1024 * 1024);
  const lang = norm(b.lang);

  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw bad('Этот email уже зарегистрирован');

  let familyId;
  let relationTo = null;
  let newFamily = false;
  if (b.familyMode === 'join') {
    const code = str(b.inviteCode, 'Код семьи', { min: 4, max: 20 }).toUpperCase();
    const fam = await db.get('SELECT id FROM families WHERE invite_code = ?', [code]);
    if (!fam) throw bad('Семья с таким кодом не найдена');
    familyId = fam.id;
    if (b.relationTo) {
      const rel = await db.get('SELECT id FROM users WHERE id = ? AND family_id = ?', [Number(b.relationTo), familyId]);
      if (!rel) throw bad('Выбранный родственник не найден');
      relationTo = rel.id;
    }
  } else {
    const famName = str(b.familyName, 'Название семьи', { min: 2, max: 60 });
    const r = await db.run('INSERT INTO families (name, invite_code) VALUES (?, ?) RETURNING id', [famName, await uniqueInviteCode()]);
    familyId = r.rows[0].id;
    newFamily = true;
  }

  const hash = await bcrypt.hash(password, 10);
  const r = await db.run(
    'INSERT INTO users (family_id, name, email, password_hash, role, relation_to, avatar, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [familyId, name, email, hash, b.role, relationTo, avatar, lang]
  );
  const uid = r.rows[0].id;
  if (newFamily) await db.run('UPDATE families SET owner_id = ? WHERE id = ?', [uid, familyId]);
  setAuthCookie(res, uid, 0);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  limit(`login-ip:${req.ip}`, 30, 15 * 60e3);
  limit(`login:${email}`, 10, 15 * 60e3);
  const u = await db.get('SELECT id, password_hash, session_version FROM users WHERE email = ?', [email]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, t('Неверный email или пароль'));
  hits.delete(`login:${email}`);
  setAuthCookie(res, u.id, u.session_version);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// выйти на всех устройствах: старые токены перестают совпадать по версии
app.post('/api/logout-all', auth, wrap(async (req, res) => {
  await db.run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [req.user.id]);
  await db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
  res.clearCookie('token');
  res.json({ ok: true });
}));

// ---------- восстановление и смена пароля ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

app.post('/api/password/forgot', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  limit(`forgot-ip:${req.ip}`, 10, 60 * 60e3);
  limit(`forgot:${email}`, 3, 60 * 60e3);
  if (!mail.enabled) throw bad('Отправка писем не настроена — обратитесь к главе семьи');
  const u = await db.get(`SELECT ${RCPT} FROM users WHERE email = ?`, [email]);
  // ответ одинаковый, есть такой email или нет — чтобы нельзя было проверять чужие адреса
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
      sha256(token), u.id, new Date(Date.now() + 3600e3).toISOString(),
    ]);
    notify([u], 'reset', {}, `${baseUrl(req)}/#/reset/${token}`, { force: true });
  }
  res.json({ ok: true });
}));

app.post('/api/password/reset', wrap(async (req, res) => {
  limit(`reset-ip:${req.ip}`, 20, 60 * 60e3);
  const token = String(req.body?.token || '');
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length < 6) throw bad('Пароль должен быть не короче 6 символов');
  const row = await db.get('SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = ?', [sha256(token)]);
  if (!row || Number(row.used) || new Date(row.expires_at) < new Date()) throw bad('Ссылка для сброса пароля недействительна или устарела');
  const hash = await bcrypt.hash(password, 10);
  await db.run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [hash, row.user_id]);
  await db.run('DELETE FROM password_resets WHERE user_id = ?', [row.user_id]);
  const u = await db.get('SELECT session_version FROM users WHERE id = ?', [row.user_id]);
  setAuthCookie(res, row.user_id, u.session_version);
  res.json({ ok: true });
}));

app.put('/api/me/password', auth, wrap(async (req, res) => {
  limit(`chpwd:${req.user.id}`, 10, 15 * 60e3);
  const current = String(req.body?.current || '');
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const u = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(current, u.password_hash))) throw bad('Неверный текущий пароль');
  if (password.length < 6) throw bad('Пароль должен быть не короче 6 символов');
  await db.run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [await bcrypt.hash(password, 10), req.user.id]);
  // остальные устройства выйдут, это — остаётся в аккаунте
  setAuthCookie(res, req.user.id, Number(req.user.session_version) + 1);
  res.json({ ok: true });
}));

// ---------- профиль и семья ----------
app.get('/api/me', auth, wrap(async (req, res) => {
  const fid = req.user.family_id;
  const fam = await loadFamily(fid);
  const members = await db.all(
    `SELECT id, name, role, relation_to, CASE WHEN avatar IS NULL THEN 0 ELSE 1 END AS has_avatar
       FROM users WHERE family_id = ? ORDER BY id`,
    [fid]
  );
  // бывшие участники, чьи имена встречаются в истории семьи
  const former = await db.all(
    `SELECT id, name, role FROM users WHERE family_id <> ? AND id IN (
        SELECT creator_id FROM items WHERE family_id = ?
        UNION SELECT c.user_id FROM contributions c JOIN items i ON i.id = c.item_id WHERE i.family_id = ?
        UNION SELECT m.user_id FROM messages m JOIN items i ON i.id = m.item_id WHERE i.family_id = ?)`,
    [fid, fid, fid, fid]
  );
  const extra = await db.get('SELECT kaspi_phone, notify_email, lang FROM users WHERE id = ?', [req.user.id]);
  res.json({
    user: {
      ...publicUser(members.find((m) => m.id === req.user.id)),
      email: req.user.email,
      kaspiPhone: extra.kaspi_phone,
      notifyEmail: !!Number(extra.notify_email),
      lang: extra.lang,
    },
    family: { id: fam.id, name: fam.name, inviteCode: fam.invite_code, ownerId: fam.owner_id },
    members: members.map(publicUser),
    former: former.map((f) => ({ id: f.id, name: f.name, role: f.role, hasAvatar: false, former: true })),
    mailEnabled: mail.enabled,
  });
}));

app.put('/api/me', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'Имя', { min: 2, max: 60 });
  if (!ROLES.includes(b.role)) throw bad('Выберите, кто вы в семье');
  let relationTo = null;
  if (b.relationTo) {
    const rel = await db.get('SELECT id FROM users WHERE id = ? AND family_id = ? AND id <> ?', [Number(b.relationTo), req.user.family_id, req.user.id]);
    if (!rel) throw bad('Выбранный родственник не найден');
    relationTo = rel.id;
  }
  const kaspi = kzPhone(b.kaspiPhone, false);
  const notifyEmail = b.notifyEmail === false || b.notifyEmail === 'off' ? 0 : 1;
  await db.run('UPDATE users SET name = ?, role = ?, relation_to = ?, kaspi_phone = ?, notify_email = ? WHERE id = ?', [
    name, b.role, relationTo, kaspi, notifyEmail, req.user.id,
  ]);
  if (b.avatar !== undefined) {
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', [checkImage(b.avatar, 1024 * 1024), req.user.id]);
  }
  res.json({ ok: true });
}));

app.put('/api/me/lang', auth, wrap(async (req, res) => {
  const lang = LANGS.includes(req.body?.lang) ? req.body.lang : 'ru';
  await db.run('UPDATE users SET lang = ? WHERE id = ?', [lang, req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/avatar/:id', auth, wrap(async (req, res) => {
  const u = await db.get('SELECT avatar FROM users WHERE id = ? AND family_id = ?', [Number(req.params.id), req.user.family_id]);
  sendDataUrl(req, res, u?.avatar);
}));

app.put('/api/family', auth, wrap(async (req, res) => {
  const fam = await requireOwner(req);
  const name = str(req.body?.name, 'Название семьи', { min: 2, max: 60 });
  await db.run('UPDATE families SET name = ? WHERE id = ?', [name, fam.id]);
  res.json({ ok: true });
}));

app.post('/api/family/invite-code', auth, wrap(async (req, res) => {
  const fam = await requireOwner(req);
  const code = await uniqueInviteCode();
  await db.run('UPDATE families SET invite_code = ? WHERE id = ?', [code, fam.id]);
  res.json({ inviteCode: code });
}));

app.post('/api/family/owner', auth, wrap(async (req, res) => {
  const fam = await requireOwner(req);
  const target = await db.get('SELECT id FROM users WHERE id = ? AND family_id = ?', [Number(req.body?.userId), fam.id]);
  if (!target) throw new HttpError(404, t('Участник не найден'));
  await db.run('UPDATE families SET owner_id = ? WHERE id = ?', [target.id, fam.id]);
  res.json({ ok: true });
}));

// Исключить участника: его аккаунт переезжает в новую пустую семью, история остаётся
app.post('/api/family/members/:id/remove', auth, wrap(async (req, res) => {
  const fam = await requireOwner(req);
  const uid = Number(req.params.id);
  if (uid === req.user.id) throw bad('Нельзя удалить себя');
  const target = await db.get('SELECT id, name FROM users WHERE id = ? AND family_id = ?', [uid, fam.id]);
  if (!target) throw new HttpError(404, t('Участник не найден'));
  const active = await db.get("SELECT COUNT(*) AS n FROM items WHERE creator_id = ? AND family_id = ? AND status IN ('voting', 'funding')", [uid, fam.id]);
  if (Number(active.n)) throw bad('Сначала завершите или удалите его вещи на голосовании и сборе');

  const r = await db.run('INSERT INTO families (name, invite_code, owner_id) VALUES (?, ?, ?) RETURNING id', [
    target.name, await uniqueInviteCode(), uid,
  ]);
  await db.run('UPDATE users SET family_id = ?, relation_to = NULL, session_version = session_version + 1 WHERE id = ?', [r.rows[0].id, uid]);
  await db.run('UPDATE users SET relation_to = NULL WHERE relation_to = ? AND family_id = ?', [uid, fam.id]);
  // его голоса в незавершённых голосованиях больше не считаются; остальные голосования могли завершиться
  const voting = await db.all("SELECT id FROM items WHERE family_id = ? AND status = 'voting'", [fam.id]);
  for (const it of voting) {
    await db.run('DELETE FROM votes WHERE item_id = ? AND user_id = ?', [it.id, uid]);
    const changed = await recalcStatus(it.id);
    if (changed) await notifyStatusChange(req, it.id, changed);
  }
  res.json({ ok: true });
}));

// ---------- push ----------
app.get('/api/push/key', auth, (req, res) => res.json({ key: push.getPublicKey() }));

app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  try {
    await push.subscribe(req.user.id, req.body?.subscription);
  } catch (e) {
    throw bad(e.message);
  }
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', auth, wrap(async (req, res) => {
  await push.unsubscribe(req.user.id, req.body?.endpoint);
  res.json({ ok: true });
}));

app.post('/api/push/test', auth, wrap(async (req, res) => {
  const n = await push.count(req.user.id);
  if (!n) throw bad('Уведомления на этом аккаунте не включены');
  const msg = tpl(req.user.lang).pushTest();
  const results = await push.send([req.user.id], { title: msg.subject, body: msg.body, url: baseUrl(req) + '/#/' });
  res.json({ ok: true, sent: results.filter(Boolean).length, devices: n });
}));

// ---------- вещи ----------
app.get('/api/items', auth, wrap(async (req, res) => {
  const fid = req.user.family_id;
  const rows = await db.all(
    `SELECT ${ITEM_COLS},
            (SELECT approve FROM votes v WHERE v.item_id = i.id AND v.user_id = ?) AS my_vote
       FROM items i WHERE i.family_id = ? ORDER BY i.id DESC`,
    [req.user.id, fid]
  );
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE family_id = ?', [fid]);
  res.json(rows.map((r) => shapeItem(r, Number(n) - 1, r.my_vote)));
}));

app.post('/api/items', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 'Название', { min: 2, max: 100 });
  const description = str(b.description, 'Описание', { max: 1000 });
  const price = toMoney(b.price, 'Цена');
  if (price < 1) throw bad('Укажите цену');
  const own = toMoney(b.ownAmount || 0, 'Своих денег');
  if (own >= price) throw bad('Своих денег уже хватает — сбор не нужен');
  const kaspiPhone = kzPhone(b.kaspiPhone, true);
  const kaspiName = str(b.kaspiName, 'Имя получателя в Kaspi', { max: 60 }) || null;
  const deadline = deadlineOf(b.deadline);
  const photo = checkImage(b.photo, 3 * 1024 * 1024);
  const r = await db.run(
    `INSERT INTO items (family_id, creator_id, title, description, photo, price, own_amount, kaspi_phone, kaspi_name, deadline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.family_id, req.user.id, title, description || null, photo, price, own, kaspiPhone, kaspiName, deadline]
  );
  const id = r.rows[0].id;
  // запоминаем номер Kaspi в профиле, чтобы в следующий раз подставить
  await db.run('UPDATE users SET kaspi_phone = ? WHERE id = ? AND kaspi_phone IS NULL', [kaspiPhone, req.user.id]);

  const others = (await familyPeople(req.user.family_id)).filter((u) => u.id !== req.user.id);
  notify(others, 'created', { name: req.user.name, role: req.user.role, title, price, own, deadline: ddmm(deadline) }, itemLink(req, id));
  res.json({ id });
}));

app.get('/api/items/:id', auth, wrap(async (req, res) => {
  const fid = req.user.family_id;
  const item = await loadItem(Number(req.params.id), fid);
  const votes = await db.all('SELECT user_id, approve, created_at FROM votes WHERE item_id = ?', [item.id]);
  const contributions = await db.all(
    `SELECT id, user_id, amount, comment, status, reject_reason, created_at, reviewed_at, ${docType('receipt')} AS receipt_type
       FROM contributions WHERE item_id = ? ORDER BY id DESC`,
    [item.id]
  );
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE family_id = ?', [fid]);
  const mine = votes.find((v) => v.user_id === req.user.id);
  res.json({
    ...shapeItem(item, Number(n) - 1, mine ? mine.approve : null),
    votes: votes.map((v) => ({ userId: v.user_id, approve: !!Number(v.approve), at: v.created_at })),
    messages: await listMessages(item.id),
    contributions: contributions.map((c) => ({
      id: c.id,
      userId: c.user_id,
      amount: Number(c.amount),
      comment: c.comment,
      status: c.status,
      rejectReason: c.reject_reason,
      receiptType: c.receipt_type,
      at: c.created_at,
      reviewedAt: c.reviewed_at,
    })),
  });
}));

app.get('/api/items/:id/photo', auth, wrap(async (req, res) => {
  const i = await db.get('SELECT photo FROM items WHERE id = ? AND family_id = ?', [Number(req.params.id), req.user.family_id]);
  sendDataUrl(req, res, i?.photo);
}));

// Редактирование: пока идёт голосование — всё (смена названия/цены сбрасывает голоса),
// после — только описание, фото, реквизиты Kaspi и срок
app.put('/api/items/:id', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw forbidden('Редактировать может только автор');
  const b = req.body || {};
  const description = str(b.description, 'Описание', { max: 1000 });
  const kaspiPhone = kzPhone(b.kaspiPhone, true);
  const kaspiName = str(b.kaspiName, 'Имя получателя в Kaspi', { max: 60 }) || null;
  const deadline = b.deadline === item.deadline ? item.deadline : deadlineOf(b.deadline);
  await db.run('UPDATE items SET description = ?, kaspi_phone = ?, kaspi_name = ?, deadline = ? WHERE id = ?', [
    description || null, kaspiPhone, kaspiName, deadline, item.id,
  ]);
  if (b.photo) await db.run('UPDATE items SET photo = ? WHERE id = ?', [checkImage(b.photo, 3 * 1024 * 1024), item.id]);

  let votesReset = false;
  if (item.status === 'voting') {
    const title = str(b.title, 'Название', { min: 2, max: 100 });
    const price = toMoney(b.price, 'Цена');
    if (price < 1) throw bad('Укажите цену');
    const own = toMoney(b.ownAmount || 0, 'Своих денег');
    if (own >= price) throw bad('Своих денег уже хватает — сбор не нужен');
    if (title !== item.title || price !== Number(item.price) || own !== Number(item.own_amount)) {
      await db.run('UPDATE items SET title = ?, price = ?, own_amount = ? WHERE id = ?', [title, price, own, item.id]);
      const { n } = await db.get('SELECT COUNT(*) AS n FROM votes WHERE item_id = ?', [item.id]);
      if (Number(n)) {
        // семья соглашалась на другие условия — голосуем заново
        await db.run('DELETE FROM votes WHERE item_id = ?', [item.id]);
        await db.run("DELETE FROM reminders WHERE item_id = ? AND kind = 'vote'", [item.id]);
        votesReset = true;
        const others = (await familyPeople(req.user.family_id)).filter((u) => u.id !== req.user.id);
        notify(others, 'edited', { name: req.user.name, title, price }, itemLink(req, item.id));
      }
    }
  }
  res.json({ ok: true, votesReset });
}));

// Отклонённую заявку автор может отправить на голосование ещё раз
app.post('/api/items/:id/revote', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw forbidden('Редактировать может только автор');
  if (item.status !== 'rejected') throw bad('Отправить заново можно только отклонённую заявку');
  await db.run('DELETE FROM votes WHERE item_id = ?', [item.id]);
  await db.run("DELETE FROM reminders WHERE item_id = ? AND kind = 'vote'", [item.id]);
  await db.run(`UPDATE items SET status = 'voting', created_at = ${nowSql()} WHERE id = ?`, [item.id]);
  const others = (await familyPeople(req.user.family_id)).filter((u) => u.id !== req.user.id);
  notify(others, 'revote', { name: req.user.name, title: item.title, price: Number(item.price) }, itemLink(req, item.id));
  res.json({ ok: true });
}));

// Этап «Куплено»: автор прикладывает фото покупки или чек магазина
app.post('/api/items/:id/bought', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw forbidden('Отметить покупку может только автор');
  if (item.status !== 'done') throw bad('Отметить покупку можно после того, как деньги собраны');
  const proof = checkFile(req.body?.proof, 4 * 1024 * 1024, DOC_RE, 'Неверный формат файла (нужно фото или PDF)');
  if (!proof) throw bad('Прикрепите фото покупки или чек из магазина');
  const note = str(req.body?.note, 'Заметка', { max: 300 }) || null;
  await db.run("UPDATE items SET status = 'bought', bought_at = ?, bought_proof = ?, bought_note = ? WHERE id = ?", [
    new Date().toISOString(), proof, note, item.id,
  ]);
  const others = (await familyPeople(req.user.family_id)).filter((u) => u.id !== req.user.id);
  notify(others, 'bought', { name: req.user.name, title: item.title, note: note || '' }, itemLink(req, item.id));
  res.json({ ok: true });
}));

app.get('/api/items/:id/bought-proof', auth, wrap(async (req, res) => {
  const i = await db.get('SELECT bought_proof FROM items WHERE id = ? AND family_id = ?', [Number(req.params.id), req.user.family_id]);
  sendDataUrl(req, res, i?.bought_proof);
}));

app.post('/api/items/:id/vote', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id === req.user.id) throw bad('Автор не голосует за свою вещь');
  if (item.status !== 'voting') throw bad('Голосование уже завершено');
  const approve = req.body?.approve ? 1 : 0;
  await db.run('DELETE FROM votes WHERE item_id = ? AND user_id = ?', [item.id, req.user.id]);
  await db.run('INSERT INTO votes (item_id, user_id, approve) VALUES (?, ?, ?)', [item.id, req.user.id, approve]);
  const changed = await recalcStatus(item.id);

  notify([await person(item.creator_id)], 'voted', { name: req.user.name, role: req.user.role, title: item.title, approve: !!approve }, itemLink(req, item.id));
  if (changed) await notifyStatusChange(req, item.id, changed);
  res.json({ ok: true, status: changed });
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw forbidden('Удалить может только автор');
  if (Number(item.contrib_count) > 0) throw bad('Нельзя удалить — по вещи уже есть взносы');
  await db.run('DELETE FROM votes WHERE item_id = ?', [item.id]);
  await db.run('DELETE FROM messages WHERE item_id = ?', [item.id]);
  await db.run('DELETE FROM reminders WHERE item_id = ?', [item.id]);
  await db.run('DELETE FROM items WHERE id = ?', [item.id]);
  res.json({ ok: true });
}));

// ---------- обсуждение вещи ----------
async function listMessages(itemId, afterId = 0) {
  const rows = await db.all(
    `SELECT m.id, m.user_id, m.text, m.contribution_id, m.created_at, c.amount AS c_amount, c.user_id AS c_user_id, c.status AS c_status
       FROM messages m LEFT JOIN contributions c ON c.id = m.contribution_id
      WHERE m.item_id = ? AND m.id > ? ORDER BY m.id`,
    [itemId, afterId]
  );
  return rows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    text: m.text,
    at: m.created_at,
    contribution: m.contribution_id
      ? { id: m.contribution_id, amount: Number(m.c_amount), userId: m.c_user_id, status: m.c_status }
      : null,
  }));
}

app.get('/api/items/:id/messages', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  res.json(await listMessages(item.id, Number(req.query.after) || 0));
}));

app.post('/api/items/:id/messages', auth, wrap(async (req, res) => {
  limit(`msg:${req.user.id}`, 30, 60e3);
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  const text = str(req.body?.text, 'Сообщение', { min: 1, max: 1000 });
  let quoted = null;
  if (req.body?.contributionId) {
    quoted = await db.get('SELECT id, user_id, amount FROM contributions WHERE id = ? AND item_id = ?', [Number(req.body.contributionId), item.id]);
    if (!quoted) throw bad('Перевод не найден');
  }
  const r = await db.run('INSERT INTO messages (item_id, user_id, contribution_id, text) VALUES (?, ?, ?, ?) RETURNING id', [
    item.id, req.user.id, quoted ? quoted.id : null, text,
  ]);

  // только push всем остальным (письмо на каждое сообщение — слишком шумно)
  let prefix = '';
  if (quoted) {
    const who = await db.get('SELECT name FROM users WHERE id = ?', [quoted.user_id]);
    prefix = `↪ ${who?.name || ''} · ${fmt(quoted.amount)}: `;
  }
  const others = (await familyPeople(req.user.family_id)).filter((u) => u.id !== req.user.id);
  const groups = new Map();
  for (const u of others) groups.set(norm(u.lang), [...(groups.get(norm(u.lang)) || []), u.id]);
  for (const [lang, ids] of groups) {
    push.send(ids, {
      title: tpl(lang).chat({ name: req.user.name, title: item.title }).subject,
      body: (prefix + text).slice(0, 240),
      url: itemLink(req, item.id) + '?chat',
    });
  }
  res.json({ id: r.rows[0].id });
}));

app.delete('/api/messages/:id', auth, wrap(async (req, res) => {
  const m = await db.get(
    'SELECT m.id, m.user_id FROM messages m JOIN items i ON i.id = m.item_id WHERE m.id = ? AND i.family_id = ?',
    [Number(req.params.id), req.user.family_id]
  );
  if (!m) throw notFound();
  if (m.user_id !== req.user.id) throw forbidden('Удалить можно только своё сообщение');
  await db.run('DELETE FROM messages WHERE id = ?', [m.id]);
  res.json({ ok: true });
}));

// ---------- взносы (Kaspi + чек) ----------
app.post('/api/items/:id/contribute', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.status !== 'funding') throw bad('Сбор по этой вещи сейчас не идёт');
  const amount = toMoney(req.body?.amount, 'Сумма');
  if (amount < 1) throw bad('Введите сумму');
  const shaped = shapeItem(item, 0, null);
  if (amount > shaped.available) {
    throw shaped.available
      ? bad('Можно отправить не больше {sum} — часть суммы уже ждёт подтверждения', { sum: fmt(shaped.available) })
      : bad('Вся оставшаяся сумма уже ждёт подтверждения');
  }
  const receipt = checkFile(req.body?.receipt, 4 * 1024 * 1024, DOC_RE, 'Неверный формат чека (нужно фото или PDF)');
  if (!receipt) throw bad('Прикрепите чек перевода (фото или PDF)');
  const comment = str(req.body?.comment, 'Комментарий', { max: 200 });
  // автор сам себе переводит — подтверждать нечего
  const selfPay = item.creator_id === req.user.id;
  await db.run('INSERT INTO contributions (item_id, user_id, amount, comment, receipt, status) VALUES (?, ?, ?, ?, ?, ?)', [
    item.id, req.user.id, amount, comment || null, receipt, selfPay ? 'confirmed' : 'pending',
  ]);
  if (selfPay) {
    const changed = await recalcStatus(item.id);
    if (changed) await notifyStatusChange(req, item.id, changed);
  } else {
    notify([await person(item.creator_id)], 'contribution', { name: req.user.name, amount, title: item.title, comment: comment || '' }, itemLink(req, item.id));
  }
  res.json({ ok: true, status: selfPay ? 'confirmed' : 'pending' });
}));

async function loadContribution(req) {
  const c = await db.get(
    `SELECT c.id, c.item_id, c.user_id, c.amount, c.status, i.creator_id, i.family_id, i.title, i.status AS item_status
       FROM contributions c JOIN items i ON i.id = c.item_id
      WHERE c.id = ? AND i.family_id = ?`,
    [Number(req.params.id), req.user.family_id]
  );
  if (!c) throw notFound();
  return c;
}

app.get('/api/contributions/:id/receipt', auth, wrap(async (req, res) => {
  const c = await loadContribution(req);
  const r = await db.get('SELECT receipt FROM contributions WHERE id = ?', [c.id]);
  sendDataUrl(req, res, r?.receipt);
}));

app.post('/api/contributions/:id/confirm', auth, wrap(async (req, res) => {
  const c = await loadContribution(req);
  if (c.creator_id !== req.user.id) throw forbidden('Подтверждает получатель — автор вещи');
  if (c.status !== 'pending') throw bad('Этот взнос уже проверен');
  await db.run(`UPDATE contributions SET status = 'confirmed', reviewed_at = ${nowSql()} WHERE id = ?`, [c.id]);
  const changed = await recalcStatus(c.item_id);
  notify([await person(c.user_id)], 'confirmed', { by: req.user.name, amount: Number(c.amount), title: c.title }, itemLink(req, c.item_id));
  if (changed) await notifyStatusChange(req, c.item_id, changed);
  res.json({ ok: true, status: changed });
}));

app.post('/api/contributions/:id/reject', auth, wrap(async (req, res) => {
  const c = await loadContribution(req);
  if (c.creator_id !== req.user.id) throw forbidden('Отклоняет получатель — автор вещи');
  if (c.status !== 'pending') throw bad('Этот взнос уже проверен');
  const reason = str(req.body?.reason, 'Причина', { min: 2, max: 200 });
  await db.run(`UPDATE contributions SET status = 'rejected', reject_reason = ?, reviewed_at = ${nowSql()} WHERE id = ?`, [reason, c.id]);
  notify([await person(c.user_id)], 'contribRejected', { by: req.user.name, amount: Number(c.amount), title: c.title, reason }, itemLink(req, c.item_id));
  res.json({ ok: true });
}));

// ---------- статистика семьи ----------
app.get('/api/stats', auth, wrap(async (req, res) => {
  const fid = req.user.family_id;
  const contribs = await db.all(
    `SELECT c.user_id, c.amount, c.created_at FROM contributions c JOIN items i ON i.id = c.item_id
      WHERE i.family_id = ? AND c.status = 'confirmed'`,
    [fid]
  );
  const items = await db.all(
    `SELECT id, creator_id, title, price, own_amount, status, created_at, bought_at FROM items WHERE family_id = ? ORDER BY id DESC`,
    [fid]
  );
  const byUser = new Map();
  const byMonth = new Map();
  let total = 0;
  for (const c of contribs) {
    const a = Number(c.amount);
    total += a;
    const u = byUser.get(c.user_id) || { userId: c.user_id, sum: 0, count: 0 };
    u.sum += a;
    u.count++;
    byUser.set(c.user_id, u);
    const m = toDate(c.created_at).toISOString().slice(0, 7);
    byMonth.set(m, (byMonth.get(m) || 0) + a);
  }
  // последние 12 месяцев, включая пустые
  const months = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let k = 11; k >= 0; k--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1));
    const key = x.toISOString().slice(0, 7);
    months.push({ month: key, sum: byMonth.get(key) || 0 });
  }
  const count = (s) => items.filter((i) => i.status === s).length;
  res.json({
    total,
    counts: { voting: count('voting'), funding: count('funding'), done: count('done'), bought: count('bought'), rejected: count('rejected') },
    people: [...byUser.values()].sort((a, b) => b.sum - a.sum),
    months,
    history: items
      .filter((i) => i.status === 'done' || i.status === 'bought')
      .map((i) => ({ id: i.id, title: i.title, price: Number(i.price), creatorId: i.creator_id, status: i.status, boughtAt: i.bought_at, createdAt: i.created_at })),
  });
}));

// ---------- напоминания (раз в час) ----------
// Голос не отдан сутки → голосующему; чек не проверен 2 суток → автору; до срока ≤ 3 дней → всем.
// Не чаще раза в сутки и не больше 3 раз на человека по каждой вещи.
async function remindOnce(kind, itemId, userId) {
  const r = await db.get('SELECT sent_at, times FROM reminders WHERE kind = ? AND item_id = ? AND user_id = ?', [kind, itemId, userId]);
  if (r && (Number(r.times) >= 3 || Date.now() - new Date(r.sent_at).getTime() < 23 * 3600e3)) return false;
  const now = new Date().toISOString();
  if (r) await db.run('UPDATE reminders SET sent_at = ?, times = times + 1 WHERE kind = ? AND item_id = ? AND user_id = ?', [now, kind, itemId, userId]);
  else await db.run('INSERT INTO reminders (kind, item_id, user_id, sent_at) VALUES (?, ?, ?, ?)', [kind, itemId, userId, now]);
  return true;
}

async function runReminders() {
  const DAY = 864e5;
  const items = await db.all(`SELECT ${ITEM_COLS} FROM items i WHERE i.status IN ('voting', 'funding')`);
  for (const it of items) {
    const link = itemLink(null, it.id);
    const people = await familyPeople(it.family_id);
    const creator = people.find((p) => p.id === it.creator_id);
    if (it.status === 'voting' && Date.now() - toDate(it.created_at).getTime() > DAY) {
      const voted = new Set((await db.all('SELECT user_id FROM votes WHERE item_id = ?', [it.id])).map((v) => v.user_id));
      for (const p of people) {
        if (p.id === it.creator_id || voted.has(p.id)) continue;
        if (await remindOnce('vote', it.id, p.id)) notify([p], 'remindVote', { title: it.title, name: creator?.name || '' }, link);
      }
    }
    if (it.status === 'funding') {
      if (Number(it.pending_count) && creator) {
        const oldest = await db.get("SELECT MIN(created_at) AS t FROM contributions WHERE item_id = ? AND status = 'pending'", [it.id]);
        if (oldest?.t && Date.now() - toDate(oldest.t).getTime() > 2 * DAY && (await remindOnce('review', it.id, creator.id))) {
          notify([creator], 'remindReview', { title: it.title, count: Number(it.pending_count) }, link);
        }
      }
      if (it.deadline) {
        const days = Math.round((Date.parse(it.deadline) - Date.parse(todayKz())) / DAY);
        const left = shapeItem(it, 0, null).remaining;
        if (days >= 0 && days <= 3 && left > 0) {
          for (const p of people) {
            if (await remindOnce('deadline', it.id, p.id)) {
              notify([p], 'remindDeadline', { title: it.title, days, left, deadline: ddmm(it.deadline) }, link);
            }
          }
        }
      }
    }
  }
}
const safeReminders = () => runReminders().catch((e) => console.error('[reminders]', e.message));

// ---------- static & errors ----------
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/', sendIndex);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.get(/^\/(?!api\/).*/, sendIndex);

app.use('/api', (req, res) => res.status(404).json({ error: t('Не найдено') }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: t('Файл слишком большой') });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : t('Ошибка сервера') });
});

db.init()
  .then(() => push.init())
  .then(() => {
    app.listen(PORT, () =>
      console.log(`Сервер запущен: http://localhost:${PORT} (БД: ${db.kind}, почта: ${mail.enabled ? 'Brevo' : 'выкл'})`));
    setTimeout(safeReminders, Number(process.env.REMINDER_FIRST_DELAY_MS) || 60e3);
    setInterval(safeReminders, 3600e3);
  })
  .catch((e) => {
    console.error('Не удалось подключиться к БД', e);
    process.exit(1);
  });

module.exports = { runReminders };
