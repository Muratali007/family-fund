const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

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
app.use(express.json({ limit: '6mb' }));
app.use(cookieParser());

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
function checkImage(dataUrl, maxBytes) {
  if (dataUrl == null || dataUrl === '') return null;
  if (typeof dataUrl !== 'string' || !IMG_RE.test(dataUrl)) throw bad('Неверный формат изображения');
  if (dataUrl.length * 0.75 > maxBytes) throw bad('Изображение слишком большое');
  return dataUrl;
}

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
    hasAvatar: !!u.has_avatar,
  };
}

// Пересчёт статуса вещи после голосования / взноса
async function recalcStatus(itemId) {
  const item = await db.get('SELECT * FROM items WHERE id = ?', [itemId]);
  if (!item) return;
  if (item.status === 'voting') {
    const voters = await db.all('SELECT id FROM users WHERE family_id = ? AND id <> ?', [item.family_id, item.creator_id]);
    if (voters.length === 0) return;
    const votes = await db.all('SELECT user_id, approve FROM votes WHERE item_id = ?', [itemId]);
    const byUser = new Map(votes.map((v) => [v.user_id, Number(v.approve)]));
    const allVoted = voters.every((v) => byUser.has(v.id));
    if (!allVoted) return;
    const allYes = voters.every((v) => byUser.get(v.id) === 1);
    await db.run('UPDATE items SET status = ? WHERE id = ?', [allYes ? 'funding' : 'rejected', itemId]);
    if (allYes) return recalcStatus(itemId);
  } else if (item.status === 'funding') {
    const { s } = await db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM contributions WHERE item_id = ?', [itemId]);
    if (Number(s) + Number(item.own_amount) >= Number(item.price)) {
      await db.run("UPDATE items SET status = 'done' WHERE id = ?", [itemId]);
    }
  }
}

async function loadItem(id, familyId) {
  const item = await db.get(
    `SELECT i.id, i.family_id, i.creator_id, i.title, i.description, i.price, i.own_amount, i.status, i.created_at,
            CASE WHEN i.photo IS NULL THEN 0 ELSE 1 END AS has_photo,
            (SELECT COALESCE(SUM(amount), 0) FROM contributions c WHERE c.item_id = i.id) AS collected,
            (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 1) AS yes_count,
            (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 0) AS no_count
       FROM items i WHERE i.id = ? AND i.family_id = ?`,
    [id, familyId]
  );
  if (!item) throw new HttpError(404, 'Не найдено');
  return item;
}

function shapeItem(i, votersCount, myVote) {
  const collected = Number(i.collected) + Number(i.own_amount);
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
    remaining: Math.max(0, Number(i.price) - collected),
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
  res.json({
    user: { ...publicUser(members.find((m) => m.id === req.user.id)), email: req.user.email },
    family: { id: fam.id, name: fam.name, inviteCode: fam.invite_code },
    members: members.map(publicUser),
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
  await db.run('UPDATE users SET name = ?, role = ?, relation_to = ? WHERE id = ?', [name, b.role, relationTo, req.user.id]);
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
    `SELECT i.id, i.creator_id, i.title, i.description, i.price, i.own_amount, i.status, i.created_at,
            CASE WHEN i.photo IS NULL THEN 0 ELSE 1 END AS has_photo,
            (SELECT COALESCE(SUM(amount), 0) FROM contributions c WHERE c.item_id = i.id) AS collected,
            (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 1) AS yes_count,
            (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.approve = 0) AS no_count,
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
  const photo = checkImage(b.photo, 3 * 1024 * 1024);
  const r = await db.run(
    'INSERT INTO items (family_id, creator_id, title, description, photo, price, own_amount) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [req.user.family_id, req.user.id, title, description || null, photo, price, own]
  );
  res.json({ id: r.rows[0].id });
}));

app.get('/api/items/:id', auth, wrap(async (req, res) => {
  const fid = req.user.family_id;
  const item = await loadItem(Number(req.params.id), fid);
  const votes = await db.all('SELECT user_id, approve, created_at FROM votes WHERE item_id = ?', [item.id]);
  const contributions = await db.all(
    'SELECT id, user_id, amount, comment, created_at FROM contributions WHERE item_id = ? ORDER BY id DESC',
    [item.id]
  );
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE family_id = ?', [fid]);
  const mine = votes.find((v) => v.user_id === req.user.id);
  res.json({
    ...shapeItem(item, Number(n) - 1, mine ? mine.approve : null),
    votes: votes.map((v) => ({ userId: v.user_id, approve: !!Number(v.approve), at: v.created_at })),
    contributions: contributions.map((c) => ({
      id: c.id, userId: c.user_id, amount: Number(c.amount), comment: c.comment, at: c.created_at,
    })),
  });
}));

app.get('/api/items/:id/photo', auth, wrap(async (req, res) => {
  const i = await db.get('SELECT photo FROM items WHERE id = ? AND family_id = ?', [Number(req.params.id), req.user.family_id]);
  sendDataUrl(req, res, i?.photo);
}));

app.post('/api/items/:id/vote', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id === req.user.id) throw bad('Автор не голосует за свою вещь');
  if (item.status !== 'voting') throw bad('Голосование уже завершено');
  const approve = req.body?.approve ? 1 : 0;
  await db.run('DELETE FROM votes WHERE item_id = ? AND user_id = ?', [item.id, req.user.id]);
  await db.run('INSERT INTO votes (item_id, user_id, approve) VALUES (?, ?, ?)', [item.id, req.user.id, approve]);
  await recalcStatus(item.id);
  res.json({ ok: true });
}));

app.post('/api/items/:id/contribute', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.status !== 'funding') throw bad('Сбор по этой вещи сейчас не идёт');
  const amount = toMoney(req.body?.amount, 'Сумма');
  if (amount < 1) throw bad('Введите сумму');
  const remaining = Number(item.price) - Number(item.own_amount) - Number(item.collected);
  if (amount > remaining) throw bad(`Осталось собрать только ${remaining.toLocaleString('ru-RU')} ₸`);
  const comment = str(req.body?.comment, 'Комментарий', { max: 200 });
  await db.run('INSERT INTO contributions (item_id, user_id, amount, comment) VALUES (?, ?, ?, ?)', [
    item.id, req.user.id, amount, comment || null,
  ]);
  await recalcStatus(item.id);
  res.json({ ok: true });
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  const item = await loadItem(Number(req.params.id), req.user.family_id);
  if (item.creator_id !== req.user.id) throw new HttpError(403, 'Удалить может только автор');
  if (Number(item.collected) > 0) throw bad('Нельзя удалить — по вещи уже есть взносы');
  await db.run('DELETE FROM votes WHERE item_id = ?', [item.id]);
  await db.run('DELETE FROM items WHERE id = ?', [item.id]);
  res.json({ ok: true });
}));

// ---------- static & errors ----------
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Файл слишком большой' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Ошибка сервера' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT} (БД: ${db.kind})`)))
  .catch((e) => {
    console.error('Не удалось подключиться к БД', e);
    process.exit(1);
  });
