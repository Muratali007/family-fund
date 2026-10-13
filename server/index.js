const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db'); // первым — он подгружает .env.local
const mail = require('./mail');

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
  .replace(/(href="\/styles\.css|src="\/app\.js)"/g, `$1?v=${VERSION}"`);
const sendIndex = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);

app.use('/api', (req, res, next) => {
  res.set('X-App-Version', VERSION);
  next();
});

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

const IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const RECEIPT_RE = /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
function checkFile(dataUrl, maxBytes, re = IMG_RE, what = 'изображения') {
  if (dataUrl == null || dataUrl === '') return null;
  if (typeof dataUrl !== 'string' || !re.test(dataUrl)) throw bad(`Неверный формат ${what}`);
  if (dataUrl.length * 0.75 > maxBytes) throw bad('Файл слишком большой');
  return dataUrl;
}
const checkImage = (d, max) => checkFile(d, max);

function toMoney(v, field) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw bad(`Некорректное значение: ${field}`);
  return n;
}

function str(v, field, { min = 0, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw bad(`Заполните поле: ${field}`);
  if (s.length > max) throw bad(`Слишком длинное поле: ${field}`);
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

const fmt = (n) => Number(n).toLocaleString('ru-RU') + ' ₸';

function genInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function setAuthCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '60d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 60 * 24 * 3600 * 1000,
  });
}

const auth = wrap(async (req, res, next) => {
  try {
    const { uid } = jwt.verify(req.cookies.token || '', JWT_SECRET);
    const user = await db.get('SELECT id, family_id, name, email, role, relation_to FROM users WHERE id = ?', [uid]);
    if (!user) throw new Error();
    req.user = user;
    next();
  } catch {
    throw new HttpError(401, 'Требуется вход');
  }
});

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
const origin = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
const itemLink = (req, id) => `${origin(req)}/#/item/${id}`;
const familyEmails = (familyId) =>
  db.all('SELECT id, name, email, notify_email FROM users WHERE family_id = ?', [familyId]);
const userEmail = (id) => db.get('SELECT id, name, email, notify_email FROM users WHERE id = ?', [id]);

async function notifyStatusChange(req, itemId, to) {
  const item = await db.get('SELECT id, family_id, creator_id, title, price, own_amount, kaspi_phone, kaspi_name FROM items WHERE id = ?', [itemId]);
  const creator = await userEmail(item.creator_id);
  const all = await familyEmails(item.family_id);
  const link = itemLink(req, item.id);
  const t = mail.esc(item.title);
  if (to === 'funding') {
    mail.notify(all, `Сбор начался: ${item.title}`, {
      lines: [
        `Все одобрили «<b>${t}</b>». Нужно собрать <b>${fmt(Number(item.price) - Number(item.own_amount))}</b>.`,
        `Перевод на Kaspi: <b>${mail.esc(item.kaspi_phone || '—')}</b> (${mail.esc(item.kaspi_name || creator.name)}). После перевода прикрепите чек на сайте.`,
      ],
      url: link,
      button: 'Помочь',
    });
  } else if (to === 'rejected') {
    mail.notify([creator], `Отклонено: ${item.title}`, {
      lines: [`Семья решила, что «<b>${t}</b>» пока не нужна.`],
      url: link,
    });
  } else if (to === 'done') {
    mail.notify(all, `Собрано! ${item.title}`, {
      lines: [`🎉 На «<b>${t}</b>» собрана вся сумма — ${fmt(item.price)}. Спасибо всем!`],
      url: link,
    });
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

const ITEM_COLS = `i.id, i.family_id, i.creator_id, i.title, i.description, i.price, i.own_amount, i.status, i.created_at,
  i.kaspi_phone, i.kaspi_name,
  CASE WHEN i.photo IS NULL THEN 0 ELSE 1 END AS has_photo,
  (SELECT COALESCE(SUM(amount), 0) FROM contributions c WHERE c.item_id = i.id AND c.status = 'confirmed') AS collected,
  (SELECT COALESCE(SUM(amount), 0) FROM contributions c WHERE c.item_id = i.id AND c.status = 'pending') AS pending_sum,
  (SELECT COUNT(*) FROM contributions c WHERE c.item_id = i.id AND c.status = 'pending') AS pending_count,
  (SELECT COUNT(*) FROM contributions c WHERE c.item_id = i.id) AS contrib_count,
  (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 1) AS yes_count,
  (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 0) AS no_count`;

async function loadItem(id, familyId) {
  const item = await db.get(`SELECT ${ITEM_COLS} FROM items i WHERE i.id = ? AND i.family_id = ?`, [id, familyId]);
  if (!item) throw new HttpError(404, 'Не найдено');
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
    kaspiPhone: i.kaspi_phone,
    kaspiName: i.kaspi_name,
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

// ---------- auth ----------
app.get('/api/roles', (req, res) => res.json(ROLES));

app.get('/api/family-preview', wrap(async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const fam = await db.get('SELECT id, name FROM families WHERE invite_code = ?', [code]);
  if (!fam) throw new HttpError(404, 'Семья с таким кодом не найдена');
  const members = await db.all('SELECT id, name, role FROM users WHERE family_id = ? ORDER BY id', [fam.id]);
  res.json({ name: fam.name, members });
}));

app.post('/api/register', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'Имя', { min: 2, max: 60 });
  const email = str(b.email, 'Email', { min: 3, max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Некорректный email');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 6) throw bad('Пароль должен быть не короче 6 символов');
  if (!ROLES.includes(b.role)) throw bad('Выберите, кто вы в семье');
  const avatar = checkImage(b.avatar, 1024 * 1024);

  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw bad('Этот email уже зарегистрирован');

  let familyId;
  let relationTo = null;
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
    let code;
    do code = genInviteCode();
    while (await db.get('SELECT id FROM families WHERE invite_code = ?', [code]));
    const r = await db.run('INSERT INTO families (name, invite_code) VALUES (?, ?) RETURNING id', [famName, code]);
    familyId = r.rows[0].id;
  }

  const hash = await bcrypt.hash(password, 10);
  const r = await db.run(
    'INSERT INTO users (family_id, name, email, password_hash, role, relation_to, avatar) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [familyId, name, email, hash, b.role, relationTo, avatar]
  );
  setAuthCookie(res, r.rows[0].id);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const u = await db.get('SELECT id, password_hash FROM users WHERE email = ?', [email]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Неверный email или пароль');
  setAuthCookie(res, u.id);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, wrap(async (req, res) => {
  const fam = await db.get('SELECT id, name, invite_code FROM families WHERE id = ?', [req.user.family_id]);
  const members = await db.all(
    `SELECT id, name, role, relation_to, CASE WHEN avatar IS NULL THEN 0 ELSE 1 END AS has_avatar
       FROM users WHERE family_id = ? ORDER BY id`,
    [req.user.family_id]
  );
  const extra = await db.get('SELECT kaspi_phone, notify_email FROM users WHERE id = ?', [req.user.id]);
  res.json({
    user: {
      ...publicUser(members.find((m) => m.id === req.user.id)),
      email: req.user.email,
      kaspiPhone: extra.kaspi_phone,
      notifyEmail: !!Number(extra.notify_email),
    },
    family: { id: fam.id, name: fam.name, inviteCode: fam.invite_code },
    members: members.map(publicUser),
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

app.get('/api/avatar/:id', auth, wrap(async (req, res) => {
  const u = await db.get('SELECT avatar FROM users WHERE id = ? AND family_id = ?', [Number(req.params.id), req.user.family_id]);
  sendDataUrl(req, res, u?.avatar);
}));

// ---------- items ----------
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
  const photo = checkImage(b.photo, 3 * 1024 * 1024);
  const r = await db.run(
    `INSERT INTO items (family_id, creator_id, title, description, photo, price, own_amount, kaspi_phone, kaspi_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.family_id, req.user.id, title, description || null, photo, price, own, kaspiPhone, kaspiName]
  );
  const id = r.rows[0].id;
  // запоминаем номер Kaspi в профиле, чтобы в следующий раз подставить
  await db.run('UPDATE users SET kaspi_phone = ? WHERE id = ? AND kaspi_phone IS NULL', [kaspiPhone, req.user.id]);

  const others = (await familyEmails(req.user.family_id)).filter((u) => u.id !== req.user.id);
  mail.notify(others, `${req.user.name} хочет: ${title}`, {
    lines: [
      `<b>${mail.esc(req.user.name)}</b> (${mail.esc(req.user.role)}) предлагает купить «<b>${mail.esc(title)}</b>» за <b>${fmt(price)}</b>.`,
      own ? `Своих денег есть: ${fmt(own)}, собрать нужно ${fmt(price - own)}.` : '',
      'Проголосуйте — нужна ли эта вещь. Сбор начнётся, когда одобрят все.',
    ].filter(Boolean),
    url: itemLink(req, id),
    button: 'Проголосовать',
  });
  res.json({ id });
}));

app.get('/api/items/:id', auth, wrap(async (req, res) => {
  const fid = req.user.family_id;
  const item = await loadItem(Number(req.params.id), fid);
  const votes = await db.all('SELECT user_id, approve, created_at FROM votes WHERE item_id = ?', [item.id]);
  const contributions = await db.all(
    `SELECT id, user_id, amount, comment, status, reject_reason, created_at, reviewed_at,
            CASE WHEN receipt IS NULL THEN NULL WHEN receipt LIKE 'data:application/pdf%' THEN 'pdf' ELSE 'image' END AS receipt_type
       FROM contributions WHERE item_id = ? ORDER BY id DESC`,
    [item.id]
  );
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE family_id = ?', [fid]);
  const mine = votes.find((v) => v.user_id === req.user.id);
  res.json({
    ...shapeItem(item, Number(n) - 1, mine ? mine.approve : null),
    votes: votes.map((v) => ({ userId: v.user_id, approve: !!Number(v.approve), at: v.created_at })),
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

app.put('/api/items/:id/kaspi', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw new HttpError(403, 'Менять реквизиты может только автор');
  const phone = kzPhone(req.body?.kaspiPhone, true);
  const name = str(req.body?.kaspiName, 'Имя получателя в Kaspi', { max: 60 }) || null;
  await db.run('UPDATE items SET kaspi_phone = ?, kaspi_name = ? WHERE id = ?', [phone, name, item.id]);
  res.json({ ok: true });
}));

app.post('/api/items/:id/vote', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id === req.user.id) throw bad('Автор не голосует за свою вещь');
  if (item.status !== 'voting') throw bad('Голосование уже завершено');
  const approve = req.body?.approve ? 1 : 0;
  await db.run('DELETE FROM votes WHERE item_id = ? AND user_id = ?', [item.id, req.user.id]);
  await db.run('INSERT INTO votes (item_id, user_id, approve) VALUES (?, ?, ?)', [item.id, req.user.id, approve]);
  const changed = await recalcStatus(item.id);

  mail.notify([await userEmail(item.creator_id)], `${req.user.name} ${approve ? 'за' : 'против'}: ${item.title}`, {
    lines: [`<b>${mail.esc(req.user.name)}</b> (${mail.esc(req.user.role)}) проголосовал(а) ${approve ? '👍 <b>за</b>' : '👎 <b>против</b>'} «${mail.esc(item.title)}».`],
    url: itemLink(req, item.id),
  });
  if (changed) await notifyStatusChange(req, item.id, changed);
  res.json({ ok: true, status: changed });
}));

// ---------- взносы (Kaspi + чек) ----------
app.post('/api/items/:id/contribute', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.status !== 'funding') throw bad('Сбор по этой вещи сейчас не идёт');
  const amount = toMoney(req.body?.amount, 'Сумма');
  if (amount < 1) throw bad('Введите сумму');
  const shaped = shapeItem(item, 0, null);
  if (amount > shaped.available) {
    throw bad(shaped.available
      ? `Можно отправить не больше ${fmt(shaped.available)} — часть суммы уже ждёт подтверждения`
      : 'Вся оставшаяся сумма уже ждёт подтверждения');
  }
  const receipt = checkFile(req.body?.receipt, 4 * 1024 * 1024, RECEIPT_RE, 'чека (нужно фото или PDF)');
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
    mail.notify([await userEmail(item.creator_id)], `Проверьте перевод: ${fmt(amount)} от ${req.user.name}`, {
      lines: [
        `<b>${mail.esc(req.user.name)}</b> отправил(а) <b>${fmt(amount)}</b> на «${mail.esc(item.title)}» и прикрепил(а) чек.`,
        comment ? `Комментарий: «${mail.esc(comment)}»` : '',
        'Проверьте поступление в Kaspi и подтвердите или отклоните взнос.',
      ].filter(Boolean),
      url: itemLink(req, item.id),
      button: 'Проверить чек',
    });
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
  if (!c) throw new HttpError(404, 'Не найдено');
  return c;
}

app.get('/api/contributions/:id/receipt', auth, wrap(async (req, res) => {
  const c = await loadContribution(req);
  const r = await db.get('SELECT receipt FROM contributions WHERE id = ?', [c.id]);
  sendDataUrl(req, res, r?.receipt);
}));

app.post('/api/contributions/:id/confirm', auth, wrap(async (req, res) => {
  const c = await loadContribution(req);
  if (c.creator_id !== req.user.id) throw new HttpError(403, 'Подтверждает получатель — автор вещи');
  if (c.status !== 'pending') throw bad('Этот взнос уже проверен');
  await db.run(`UPDATE contributions SET status = 'confirmed', reviewed_at = ${db.kind === 'postgres' ? 'NOW()' : "datetime('now')"} WHERE id = ?`, [c.id]);
  const changed = await recalcStatus(c.item_id);
  mail.notify([await userEmail(c.user_id)], `Взнос подтверждён: ${fmt(c.amount)}`, {
    lines: [`✅ ${mail.esc(req.user.name)} подтвердил(а), что получил(а) ваш перевод <b>${fmt(c.amount)}</b> на «${mail.esc(c.title)}». Спасибо!`],
    url: itemLink(req, c.item_id),
  });
  if (changed) await notifyStatusChange(req, c.item_id, changed);
  res.json({ ok: true, status: changed });
}));

app.post('/api/contributions/:id/reject', auth, wrap(async (req, res) => {
  const c = await loadContribution(req);
  if (c.creator_id !== req.user.id) throw new HttpError(403, 'Отклоняет получатель — автор вещи');
  if (c.status !== 'pending') throw bad('Этот взнос уже проверен');
  const reason = str(req.body?.reason, 'Причина', { min: 2, max: 200 });
  await db.run(
    `UPDATE contributions SET status = 'rejected', reject_reason = ?, reviewed_at = ${db.kind === 'postgres' ? 'NOW()' : "datetime('now')"} WHERE id = ?`,
    [reason, c.id]
  );
  mail.notify([await userEmail(c.user_id)], `Взнос не подтверждён: ${fmt(c.amount)}`, {
    lines: [
      `❌ ${mail.esc(req.user.name)} не нашёл(ла) ваш перевод <b>${fmt(c.amount)}</b> на «${mail.esc(c.title)}».`,
      `Причина: «${mail.esc(reason)}»`,
      'Сумма снова доступна для сбора. Проверьте перевод и отправьте чек ещё раз.',
    ],
    url: itemLink(req, c.item_id),
    button: 'Отправить заново',
  });
  res.json({ ok: true });
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw new HttpError(403, 'Удалить может только автор');
  if (Number(item.contrib_count) > 0) throw bad('Нельзя удалить — по вещи уже есть взносы');
  await db.run('DELETE FROM votes WHERE item_id = ?', [item.id]);
  await db.run('DELETE FROM items WHERE id = ?', [item.id]);
  res.json({ ok: true });
}));

// ---------- static & errors ----------
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/', sendIndex);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.get(/^\/(?!api\/).*/, sendIndex);

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Файл слишком большой' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Ошибка сервера' });
});

db.init()
  .then(() => app.listen(PORT, () =>
    console.log(`Сервер запущен: http://localhost:${PORT} (БД: ${db.kind}, почта: ${mail.enabled ? 'Brevo' : 'выкл'})`)))
  .catch((e) => {
    console.error('Не удалось подключиться к БД', e);
    process.exit(1);
  });
