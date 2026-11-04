// Оновлює data/schedule.json з веб-версії публічного Telegram-каналу (t.me/s/<канал>).
// Формат слотів: рядок із 48 символів (по 30 хв): 1 = світло є, 0 = вимкнено.
// Перевірка джерела виконується під час кожного запуску GitHub Actions (кожні 5 хвилин).

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const FILE = 'data/schedule.json';
const CHANNELS = (process.env.TG_CHANNELS || 'SvitloKropyvnytskyiMisto')
  .split(',').map(s => s.trim()).filter(Boolean);
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const CHECK_METADATA_INTERVAL_MS = 60 * 60 * 1000;

const kyivDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d);
const addDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const plain = h => h.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parse(text, postedIso) {
  const postedDate = new Date(postedIso);
  if (!Number.isFinite(postedDate.getTime())) return null;

  const posted = kyivDate(postedDate);
  let date = null, m;
  if ((m = text.match(/(\d{2})\.(\d{2})\.(\d{4})/))) {
    date = `${m[3]}-${m[2]}-${m[1]}`;
  } else if ((m = text.match(new RegExp('(\\d{1,2})\\s+(' + MONTHS.join('|') + ')', 'i')))) {
    date = `${posted.slice(0, 4)}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (!date) return null;

  const out = {};
  for (const line of text.split('\n')) {
    const q = line.match(/^[^\d\n]{0,25}([1-6]\.[12])[^\d:\n]{0,15}:\s*(.*)$/);
    if (!q) continue;

    const ranges = [...q[2].matchAll(/(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?/g)];
    if (!ranges.length && /\d/.test(q[2])) continue; // незрозумілий запис не перетворюємо на графік

    const slots = Array(48).fill('1');
    let validRanges = 0;
    for (const r of ranges) {
      const startHour = +r[1], startMinute = +(r[2] || 0);
      const endHour = +r[3], endMinute = +(r[4] || 0);
      if (startHour > 24 || endHour > 24 || startMinute > 59 || endMinute > 59) continue;

      const start = startHour * 60 + startMinute;
      let end = endHour * 60 + endMinute;
      if (start >= 1440) continue;
      if (end <= start) end = 1440;

      validRanges++;
      for (let i = Math.floor(start / 30); i < Math.min(48, Math.ceil(end / 30)); i++) slots[i] = '0';
    }
    if (ranges.length && !validRanges) continue;
    out[q[1]] = slots.join('');
  }

  return Object.keys(out).length ? { date, out } : null;
}

// Telegram може тимчасово повертати 429/5xx або мережеву помилку.
// Повторюємо запит, щоб один короткий збій не зривав оновлення всього графіка.
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
      console.warn(`${channel}: спроба ${attempt}/${MAX_ATTEMPTS} не вдалася (${lastError.message}); повтор через ${delay / 1000} с`);
      await sleep(delay);
    }
  }

  throw new Error(`${channel}: не вдалося отримати дані після ${MAX_ATTEMPTS} спроб: ${lastError?.message || 'невідома помилка'}`);
}

// У HTML Telegram порядок повідомлень не вважаємо гарантованим.
// Сортуємо за часом публікації: найновіше повідомлення застосовується останнім.
export function extractPosts(html, channel) {
  return html.split('tgme_widget_message_wrap').slice(1).flatMap((wrapper, index) => {
    const textMatch = wrapper.match(/class="tgme_widget_message_text[^\"]*"[^>]*>([\s\S]*?)<\/div>/);
    const dateMatch = wrapper.match(/<time[^>]*datetime="([^\"]+)"/);
    if (!textMatch || !dateMatch) return [];

    const timestamp = Date.parse(dateMatch[1]);
    if (!Number.isFinite(timestamp)) return [];
    return [{ channel, index, timestamp, postedAt: dateMatch[1], text: plain(textMatch[1]) }];
  });
}

export function sortPostsByTimestamp(posts) {
  return [...posts].sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
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

  const days = structuredClone(old.days || {});
  const allPosts = [];
  for (const channel of CHANNELS) {
    const html = await fetchChannel(channel);
    const posts = extractPosts(html, channel);
    console.log(`${channel}: отримано ${posts.length} повідомлень`);
    allPosts.push(...posts);
  }

  if (!allPosts.length) {
    throw new Error('Telegram повернув сторінки без повідомлень. Старі дані збережено.');
  }

  const orderedPosts = sortPostsByTimestamp(allPosts);

  let parsedPosts = 0;
  let parsedQueues = 0;
  for (const post of orderedPosts) {
    const parsed = parse(post.text, post.postedAt);
    if (!parsed) continue;
    parsedPosts++;
    parsedQueues += Object.keys(parsed.out).length;
    days[parsed.date] = { ...days[parsed.date], ...parsed.out };
  }

  if (!parsedPosts || !parsedQueues) {
    throw new Error('Не вдалося розпізнати жодної публікації з графіком. Старі дані збережено; можливо, Telegram змінив HTML або формат повідомлень.');
  }

  const today = kyivDate(new Date());
  const keep = new Set([-1, 0, 1, 2].map(n => addDay(today, n)));
  for (const date of Object.keys(days)) if (!keep.has(date)) delete days[date];

  const now = new Date();
  const changed = JSON.stringify(days) !== JSON.stringify(old.days || {});
  const lastCheck = old.checked ? Date.parse(old.checked) : NaN;
  const checkMetadataIsFresh = Number.isFinite(lastCheck) && now.getTime() - lastCheck < CHECK_METADATA_INTERVAL_MS;

  // Запит до Telegram виконується при кожному запуску (кожні 5 хв).
  // Мітку checked записуємо не частіше ніж раз на годину, щоб не створювати 288 комітів щодня.
  // Коли сам графік змінився, файл зберігається негайно незалежно від цієї мітки.
  if (!changed && checkMetadataIsFresh) {
    console.log(`Перевірку завершено: графік без змін; перевірено ${parsedPosts} публікацій, ${parsedQueues} черг.`);
    return;
  }

  await mkdir('data', { recursive: true });
  await writeFile(FILE, JSON.stringify({
    checked: now.toISOString(),
    updated: changed ? now.toISOString() : (old.updated || now.toISOString()),
    source: 'telegram',
    days,
  }, null, 1) + '\n');

  console.log(changed ? 'Графік оновлено' : 'Мітку перевірки оновлено', Object.keys(days).join(', ') || '(даних немає)');
  console.log(`Підсумок: ${allPosts.length} повідомлень, ${parsedPosts} публікацій із графіком, ${parsedQueues} черг.`);
}

if (!process.env.NO_RUN) main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
