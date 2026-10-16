import nodemailer from 'nodemailer';
import { cfg } from './config.js';

const mailer = cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : null;
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

export function validDiscordWebhook(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && DISCORD_HOSTS.has(x.hostname) && x.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

export function channelsOf(m) {
  const c = [];
  if (m.email) c.push('email');
  if (m.telegram_chat) c.push('telegram');
  if (m.discord_webhook) c.push('discord');
  return c;
}

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const senders = {
  async email(m, { title, body, link }) {
    if (!mailer) throw new Error('SMTP is not configured on this server');
    await mailer.sendMail({
      from: cfg.mailFrom,
      to: m.email,
      subject: title,
      text: `${body}\n\n${link}`,
      html: `<p style="font:16px/1.5 system-ui">${esc(body).replace(/\n/g, '<br>')}</p><p><a href="${esc(link)}">Open the comparison</a></p>`,
    });
  },
  async telegram(m, { title, body, link }) {
    if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is not set on this server');
    await post(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      chat_id: m.telegram_chat,
      text: `${title}\n\n${body}\n\n${link}`.slice(0, 4000),
      disable_web_page_preview: true,
    });
  },
  async discord(m, { title, body, link }) {
    await post(m.discord_webhook, { content: `**${title}**\n${body}\n${link}`.slice(0, 1900) });
  },
};

/**
 * Delivers to every configured channel. `already` lists channels that succeeded on an earlier attempt,
 * so a retry after a partial failure never double-sends. Returns the full list of delivered channels.
 */
export async function deliver(monitor, payload, already = []) {
  const done = new Set(already);
  const errors = [];
  for (const ch of channelsOf(monitor)) {
    if (done.has(ch)) continue;
    try {
      await senders[ch](monitor, payload);
      done.add(ch);
    } catch (e) {
      errors.push(`${ch}: ${e.message}`);
    }
  }
  return { delivered: [...done], error: errors.length ? errors.join('; ') : null };
}
