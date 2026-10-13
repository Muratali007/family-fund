// Отправка писем через HTTP API Brevo (бесплатный Render блокирует SMTP).
// Без BREVO_API_KEY письма не отправляются — только пишется строка в лог.
const API_KEY = process.env.BREVO_API_KEY;
const FROM = process.env.MAIL_FROM;
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Отбасы Қоры';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, lines, url, button, footer }) {
  return `<!doctype html><html><body style="margin:0;background:#f6f4ef;font-family:Arial,sans-serif;color:#1c1b18">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border:1px solid #e3dfd5;border-radius:16px;padding:24px">
      <div style="font-size:13px;color:#6b675e;margin-bottom:8px">🏠 ${esc(FROM_NAME)}</div>
      <h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>
      ${lines.filter(Boolean).map((l) => `<p style="margin:0 0 8px;line-height:1.5">${l}</p>`).join('')}
      ${url ? `<a href="${esc(url)}" style="display:inline-block;margin-top:12px;background:#0f766e;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">${esc(button || 'Открыть')}</a>` : ''}
    </div>
    ${footer ? `<p style="font-size:12px;color:#6b675e;text-align:center;margin-top:12px">${esc(footer)}</p>` : ''}
  </div></body></html>`;
}

async function sendOne(to, subject, html) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: FROM, name: FROM_NAME },
      to: [{ email: to.email, name: to.name }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
}

// recipients: [{ email, name, notify_email }]; не блокирует запрос — ошибки только в лог.
// force — отправить даже тем, кто отключил письма (например, сброс пароля)
function notify(recipients, subject, content, { force = false } = {}) {
  const list = recipients.filter((r) => r && r.email && (force || Number(r.notify_email ?? 1) === 1));
  if (!list.length) return;
  if (!API_KEY || !FROM) {
    // ссылку пишем в лог только локально — в ней может быть токен сброса пароля
    const link = process.env.NODE_ENV !== 'production' && content.url ? ` [${content.url}]` : '';
    console.log(`[mail:off] ${subject} → ${list.map((r) => r.email).join(', ')}${link}`);
    return;
  }
  const html = layout({ title: subject, ...content });
  Promise.allSettled(list.map((r) => sendOne(r, subject, html))).then((rs) =>
    rs.forEach((r) => r.status === 'rejected' && console.error('[mail]', r.reason.message))
  );
}

module.exports = { notify, esc, enabled: !!(API_KEY && FROM) };
