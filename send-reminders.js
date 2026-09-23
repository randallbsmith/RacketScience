import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readState, transaction } from './store.js';
import { dateLabel, pacificDate, pacificParts, weekday, nextGame } from './dates.js';
export function recipients(state) {
  return [...new Set(state.players.map(p => p.email.trim().toLowerCase())
    .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith('unknown.com')))];
}
export async function sendReminders({ now = new Date(), send = false, dir, deliver = deliverEmail } = {}) {
  const today = pacificDate(now);
  const snapshot = await readState(dir);
  const list = recipients(snapshot);
  if (!send) return { dryRun: true, gameDate: snapshot.gameDate, recipients: list };
  if (![1, 4].includes(weekday(today)) || Number(pacificParts(now).hour) < 1) return { sent: 0 };
  if (snapshot.gameDate !== nextGame(today)) throw new Error('Game date is not tomorrow’s game; reset may have been missed.');
  const url = new URL(process.env.APP_URL);
  if (url.protocol !== 'https:') throw new Error('Email links require an HTTPS APP_URL.');
  let sent = 0;
  for (const email of list) {
    // Serialize delivery and its receipt with other jobs, including reset.
    await transaction(async state => {
      if (state.gameDate !== snapshot.gameDate) throw new Error('Game changed during reminder run.');
      const key = createHash('sha256').update(`${today}:${email}`).digest('hex');
      state.reminderReceipts ||= {};
      if (state.reminderReceipts[key]) return;
      await deliver({ email, key, gameDate: state.gameDate, url: url.href });
      state.reminderReceipts[key] = today;
      sent++;
    }, dir);
    // Stay below the email provider's default per-second request limit.
    await new Promise(r => setTimeout(r, 600));
  }
  return { sent };
}
async function deliverEmail({ email, key, gameDate, url }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error('Configure RESEND_API_KEY and EMAIL_FROM.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email],
      subject: `Tennis reminder: ${dateLabel(gameDate)}`,
      text: `Tennis is tomorrow, ${dateLabel(gameDate)}. Please update your availability:\n\n${url}\n\nSee you on court!` })
  });
  if (!response.ok) throw new Error(`Email service returned HTTP ${response.status}; receipt not recorded.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await sendReminders({ send: process.argv.includes('--send') }));
}
