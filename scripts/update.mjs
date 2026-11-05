// Перевіряє останні публікації публічного Telegram-каналу кожного запуску workflow.
// Файл сайту записується ЛИШЕ тоді, коли розібраний графік справді змінився.
// Формат слотів: 48 символів по 30 хвилин: 1 = світло є, 0 = відключення.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const FILE = 'data/schedule.json';
const CHANNELS = (process.env.TG_CHANNELS || 'SvitloKropyvnytskyiMisto')
  .split(',').map(s => s.trim()).filter(Boolean);
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

const kyivDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d);
const addDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([\da-f]+);/gi, (_, n) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}

const plain = html => decodeEntities(
  html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')
).replace(/\r/g, '').replace(/[\u200b\ufeff]/g, '').trim();

export function parse(text, postedIso) {
  const postedDate = new Date(postedIso);
  if (!Number.isFinite(postedDate.getTime())) return null;

  const posted = kyivDate(postedDate);
  let date = null;
  let match;
  if ((match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/))) {
    date = `${match[3]}-${match[2]}-${match[1]}`;
  } else if ((match = text.match(new RegExp('(\\d{1,2})\\s+(' + MONTHS.join('|') + ')', 'i')))) {
    date = `${posted.slice(0, 4)}-${String(MONTHS.indexOf(match[2].toLowerCase()) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  if (!date) return null;

  // Reject impossible calendar dates instead of publishing malformed keys.
  const dateCheck = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) return null;

  const out = {};
  for (const line of text.split('\n')) {
    const queueMatch = line.trim().match(/^[^\d\n]{0,25}([1-6]\.[12])[^\d:\n]{0,15}:\s*(.*)$/u);
    if (!queueMatch) continue;

    const value = queueMatch[2].trim();
    const ranges = [...value.matchAll(/(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?/g)];
    const slots = Array(48).fill('1');

    if (!ranges.length) {
      // Only treat explicit "no outages" wording as a full-day power-on schedule.
      if (!/(без\s+відключень|відключень\s+не\s+буде|немає\s+відключень|відключення\s+не\s+плануються|не\s+прогнозуються\s+відключення|світло\s+буде\s+весь\s+день)/iu.test(value)) continue;
      out[queueMatch[1]] = slots.join('');
      continue;
    }

    let validRanges = 0;
    for (const range of ranges) {
      const startHour = Number(range[1]);
      const startMinute = Number(range[2] || 0);
      const endHour = Number(range[3]);
      const endMinute = Number(range[4] || 0);
      if (startHour > 24 || endHour > 24 || startMinute > 59 || endMinute > 59) continue;

      const start = startHour * 60 + startMinute;
      let end = endHour * 60 + endMinute;
      if (start >= 1440) continue;
      if (end <= start) end = 1440;

      validRanges++;
      for (let i = Math.floor(start / 30); i < Math.min(48, Math.ceil(end / 30)); i++) slots[i] = '0';
    }
    if (!validRanges) continue;
    out[queueMatch[1]] = slots.join('');
  }

  return Object.keys(out).length ? { date, out } : null;
}

// Telegram може тимчасово повертати 429/5xx або мережеву помилку.
// Повторні спроби не дозволяють короткому збою затерти чи підмінити останні дані.
async function fetchChannel(channel) {
  const url = `https://t.me/s/${encodeURIComponent(channel)}`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; SvitloScheduleBot/1.0)',
          'cache-control': 'no-cache, no-store, max-age=0',
          'pragma': 'no-cache',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const error = new Error(`${channel}: HTTP ${response.status}`);
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          error.retryable = false;
          throw error;
        }
        lastError = error;
      } else {
        return await response.text();
      }
    } catch (error) {
      if (error?.retryable === false) throw error;
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = 1_000 * (2 ** (attempt - 1));
      console.warn(`${channel}: спроба ${attempt}/${MAX_ATTEMPTS} не вдалася (${lastError?.message || 'помилка мережі'}); повтор через ${delay / 1000} с`);
      await sleep(delay);
    }
  }

  throw new Error(`${channel}: не вдалося отримати дані після ${MAX_ATTEMPTS} спроб: ${lastError?.message || 'невідома помилка'}`);
}

// Витягує вміст div з балансом вкладених div, а не обрізає текст на першому </div>.
function extractDivContent(html, className) {
  const openTag = new RegExp(`<div\\b(?=[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'])[^>]*>`, 'i').exec(html);
  if (!openTag) return null;

  const contentStart = openTag.index + openTag[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = contentStart;
  let depth = 1;
  let tag;

  while ((tag = tags.exec(html))) {
    if (/^<\//.test(tag[0])) {
      depth--;
      if (depth === 0) return html.slice(contentStart, tag.index);
    } else if (!/\/\s*>$/.test(tag[0])) {
      depth++;
    }
  }
  return null;
}

export function extractPosts(html, channel) {
  return html.split('tgme_widget_message_wrap').slice(1).flatMap((wrapper, index) => {
    const messageHtml = extractDivContent(wrapper, 'tgme_widget_message_text');
    const dateMatch = wrapper.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i);
    if (!messageHtml || !dateMatch) return [];

    const timestamp = Date.parse(dateMatch[1]);
    if (!Number.isFinite(timestamp)) return [];

    const idMatch = wrapper.match(/\bdata-post=["'][^"']+\/(\d+)["']/i);
    return [{
      channel,
      index,
      postId: idMatch ? Number(idMatch[1]) : null,
      timestamp,
      postedAt: dateMatch[1],
      text: plain(messageHtml),
    }];
  });
}

export function sortPostsByTimestamp(posts) {
  return [...posts].sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
}

// Нормалізує порядок ключів, щоб перестановка властивостей не виглядала як зміна графіка.
export function normalizeDays(days = {}) {
  return Object.fromEntries(
    Object.keys(days).sort().map(date => [
      date,
      Object.fromEntries(Object.entries(days[date] || {}).sort(([a], [b]) => a.localeCompare(b))),
    ]),
  );
}

export function hasScheduleChanged(previousDays = {}, nextDays = {}) {
  return JSON.stringify(normalizeDays(previousDays)) !== JSON.stringify(normalizeDays(nextDays));
}

export function applyPosts(previousDays, posts) {
  const days = structuredClone(previousDays || {});
  let parsedPosts = 0;
  let parsedQueues = 0;

  // Old posts are applied first so the newest publication wins when a queue is repeated.
  for (const post of sortPostsByTimestamp(posts)) {
    const parsed = parse(post.text, post.postedAt);
    if (!parsed) continue;
    parsedPosts++;
    parsedQueues += Object.keys(parsed.out).length;
    days[parsed.date] = { ...days[parsed.date], ...parsed.out };
  }
  return { days, parsedPosts, parsedQueues };
}

async function main() {
  const rawOld = await readFile(FILE, 'utf8').catch(() => '');
  let old = { days: {} };
  if (rawOld.trim()) {
    try {
      old = JSON.parse(rawOld);
    } catch (error) {
      throw new Error(`${FILE}: некоректний JSON, файл не буде перезаписано: ${error.message}`);
    }
  }

  const allPosts = [];
  for (const channel of CHANNELS) {
    const html = await fetchChannel(channel);
    const posts = extractPosts(html, channel);
    console.log(`${channel}: отримано ${posts.length} останніх повідомлень зі сторінки каналу`);
    allPosts.push(...posts);
  }

  if (!allPosts.length) {
    throw new Error('Telegram повернув сторінки без повідомлень. Старі дані збережено; перевірте назву каналу або зміну HTML Telegram.');
  }

  const result = applyPosts(old.days || {}, allPosts);
  if (!result.parsedPosts || !result.parsedQueues) {
    throw new Error('Не вдалося розпізнати жодної публікації з графіком. Старі дані збережено; перевірте формат повідомлень Telegram.');
  }

  // Важливо: порівнюємо саме дані графіка ДО технічного очищення старих дат.
  // Якщо Telegram не змінив дані, завершуємо без запису файлу — отже GitHub не створить коміт
  // і сайт не буде перевидаватися лише через чергову перевірку.
  if (!hasScheduleChanged(old.days || {}, result.days)) {
    console.log(`Без змін: перевірено ${allPosts.length} публікацій, розпізнано ${result.parsedPosts} публікацій із графіком та ${result.parsedQueues} черг. Файл сайту не змінюється.`);
    return;
  }

  const today = kyivDate(new Date());
  const keep = new Set([-1, 0, 1, 2].map(n => addDay(today, n)));
  for (const date of Object.keys(result.days)) if (!keep.has(date)) delete result.days[date];

  const now = new Date();
  await mkdir('data', { recursive: true });
  await writeFile(FILE, JSON.stringify({
    updated: now.toISOString(),
    source: 'telegram',
    days: normalizeDays(result.days),
  }, null, 1) + '\n');

  console.log(`Знайдено зміни: графік оновлено о ${now.toISOString()}. Дати: ${Object.keys(result.days).sort().join(', ') || '(даних немає)'}`);
  console.log(`Підсумок: ${allPosts.length} повідомлень, ${result.parsedPosts} публікацій із графіком, ${result.parsedQueues} черг.`);
}

if (!process.env.NO_RUN) main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
