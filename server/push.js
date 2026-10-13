// Push-уведомления на телефон (Web Push). VAPID-ключи берутся из окружения,
// а если их нет — создаются один раз и хранятся в таблице settings.
const webpush = require('web-push');
const db = require('./db');

let publicKey = null;

async function setting(key) {
  const r = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return r?.value;
}

async function init() {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    pub = await setting('vapid_public');
    priv = await setting('vapid_private');
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['vapid_public', keys.publicKey]);
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['vapid_private', keys.privateKey]);
      // перечитываем — на случай, если ключи параллельно записал другой процесс
      pub = await setting('vapid_public');
      priv = await setting('vapid_private');
    }
  }
  const subject = process.env.MAIL_FROM ? `mailto:${process.env.MAIL_FROM}` : process.env.APP_URL || 'mailto:family-fund@example.com';
  webpush.setVapidDetails(subject, pub, priv);
  publicKey = pub;
}

async function subscribe(userId, sub) {
  const endpoint = sub?.endpoint;
  const { p256dh, auth } = sub?.keys || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
    throw new Error('Некорректная подписка');
  }
  await db.run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [userId, endpoint, String(p256dh), String(auth)]
  );
}

async function unsubscribe(userId, endpoint) {
  await db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, String(endpoint || '')]);
}

async function count(userId) {
  const r = await db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [userId]);
  return Number(r.n);
}

// Отправка на все устройства пользователей; не блокирует запрос, мёртвые подписки удаляет
function send(userIds, { title, body, url }) {
  const ids = [...new Set(userIds.filter(Boolean).map(Number))];
  if (!publicKey || !ids.length) return Promise.resolve([]);
  const payload = JSON.stringify({ title, body, url: url || '/' });
  const run = async () => {
    const subs = await db.all(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    return Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600 });
        return true;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        } else {
          console.error('[push]', e.statusCode || '', e.body || e.message);
        }
        return false;
      }
    }));
  };
  return run().catch((e) => {
    console.error('[push]', e.message);
    return [];
  });
}

module.exports = { init, subscribe, unsubscribe, count, send, getPublicKey: () => publicKey };
