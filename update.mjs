// Оновлює data/schedule.json з веб-версії публічного Telegram-каналу (t.me/s/<канал>).
// Формат слотів: рядок з 48 символів (по 30 хв): 1 = світло є, 0 = вимкнено.
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'data/schedule.json';
const CHANNELS = (process.env.TG_CHANNELS || 'SvitloKropyvnytskyiMisto').split(',').map(s => s.trim()).filter(Boolean);
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const kyivDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d);
const addDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const plain = h => h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parse(text, postedIso) {
  const posted = kyivDate(new Date(postedIso));
  let date = null, m;
  if ((m = text.match(/(\d{2})\.(\d{2})\.(\d{4})/))) date = `${m[3]}-${m[2]}-${m[1]}`;
  else if ((m = text.match(new RegExp('(\\d{1,2})\\s+(' + MONTHS.join('|') + ')', 'i')))) {
    date = `${posted.slice(0, 4)}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (!date) return null;
  const out = {};
  for (const line of text.split('\n')) {
    const q = line.match(/^[^\d\n]{0,25}([1-6]\.[12])[^\d:\n]{0,15}:\s*(.*)$/);
    if (!q) continue;
    const ranges = [...q[2].matchAll(/(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?/g)];
    if (!ranges.length && /\d/.test(q[2])) continue; // незрозумілий запис пропускаємо
    const s = Array(48).fill('1');
    for (const r of ranges) {
      const a = +r[1] * 60 + (+r[2] || 0);
      let b = +r[3] * 60 + (+r[4] || 0);
      if (b <= a) b = 1440;
      for (let i = Math.floor(a / 30); i < Math.min(48, Math.ceil(b / 30)); i++) s[i] = '0';
    }
    out[q[1]] = s.join('');
  }
  return Object.keys(out).length ? { date, out } : null;
}

async function main() {
  const old = JSON.parse((await readFile(FILE, 'utf8').catch(() => '')) || 'null') || { days: {} };
  const days = structuredClone(old.days || {});
  let posts = 0;
  for (const ch of CHANNELS) {
    const r = await fetch('https://t.me/s/' + ch, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`${ch}: HTTP ${r.status}`);
    const html = await r.text();
    for (const w of html.split('tgme_widget_message_wrap').slice(1)) {
      const t = w.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      const d = w.match(/<time[^>]*datetime="([^"]+)"/);
      if (!t || !d) continue;
      posts++;
      const p = parse(plain(t[1]), d[1]);
      if (p) days[p.date] = { ...days[p.date], ...p.out };
    }
  }
  if (!posts) throw new Error('Не знайдено жодного допису: перевірте назву каналу або розмітку Telegram');
  const today = kyivDate(new Date());
  const keep = new Set([-1, 0, 1, 2].map(n => addDay(today, n)));
  for (const d of Object.keys(days)) if (!keep.has(d)) delete days[d];
  const now = new Date();
  const changed = JSON.stringify(days) !== JSON.stringify(old.days || {});
  const fresh = old.checked && now - new Date(old.checked) < 36e5;
  if (!changed && fresh) return console.log('Без змін');
  await writeFile(FILE, JSON.stringify({
    checked: now.toISOString(),
    updated: changed ? now.toISOString() : (old.updated || now.toISOString()),
    source: 'telegram',
    days,
  }, null, 1));
  console.log(changed ? 'Графік оновлено' : 'Оновлено мітку перевірки', Object.keys(days).join(', ') || '(даних немає)');
}

if (!process.env.NO_RUN) main().catch(e => { console.error(e.message); process.exit(1); });
