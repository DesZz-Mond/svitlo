import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NO_RUN = '1';
const { parse, extractPosts, sortPostsByTimestamp } = await import('./update.mjs');

test('розпізнає дати та перетворює діапазони на 48 півгодинних слотів', () => {
  const source = [
    'Графік відключень на 04.11.2026',
    '1.1: 00:00–02:00, 04:00-06:30',
    '1.2: без відключень',
  ].join('\n');
  const result = parse(source, '2026-11-04T08:00:00Z');

  assert.equal(result.date, '2026-11-04');
  assert.equal(result.out['1.1'].length, 48);
  assert.equal(result.out['1.1'].slice(0, 4), '0000');
  assert.equal(result.out['1.1'].slice(8, 13), '00000');
  assert.equal(result.out['1.2'], '1'.repeat(48));
});

test('розпізнає дату з українською назвою місяця', () => {
  const result = parse('Графік на 5 листопада\n2.1: 10:00–12:00', '2026-11-04T08:00:00Z');
  assert.equal(result.date, '2026-11-05');
});

test('не створює графік з некоректних часових діапазонів', () => {
  const result = parse('Графік на 04.11.2026\n3.1: 99:99–99:99', '2026-11-04T08:00:00Z');
  assert.equal(result, null);
});

test('витягує повідомлення з Telegram HTML та сортує їх від старих до нових', () => {
  const html = [
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message_text">Свіже повідомлення</div><time datetime="2026-11-04T10:00:00+00:00"></time></div>',
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message_text">Старе повідомлення</div><time datetime="2026-11-04T09:00:00+00:00"></time></div>',
  ].join('');
  const posts = extractPosts(html, 'test');
  const ordered = sortPostsByTimestamp(posts);
  assert.equal(ordered[0].text, 'Старе повідомлення');
  assert.equal(ordered[1].text, 'Свіже повідомлення');
});
