import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLinks, extractLinks, linkShortcuts, renderLinksCsv, renderLinksHtml } from '../lib/links.js';
import { T0 } from './fake-max.js';

const MSK = 'Europe/Moscow';

test('links come from the text, from hyperlink markup and from link previews, once per message', () => {
  const text = 'Отчёт: https://drive.example/a?id=1, видео (https://youtu.be/xyz). Сайт www.arsenaltula.ru и подробнее здесь';
  const message = {
    text,
    elements: [
      // MAX marks a typed address as LINK over the address itself.
      { type: 'LINK', from: text.indexOf('https://drive'), length: 28, attributes: { url: 'https://drive.example/a?id=1' } },
      // A hyperlink with its own words: the words become the title.
      { type: 'UNDERLINE', from: text.indexOf('здесь'), length: 5, attributes: { url: 'https://wyscout.example/match/7' } },
    ],
    attaches: [{ _type: 'SHARE', url: 'https://youtu.be/xyz', title: 'Голы тура', description: 'обзор' }],
  };
  assert.deepEqual(extractLinks(message), [
    { url: 'https://drive.example/a?id=1', title: null },
    { url: 'https://youtu.be/xyz', title: 'Голы тура' },
    { url: 'https://www.arsenaltula.ru', title: null },
    { url: 'https://wyscout.example/match/7', title: 'здесь' },
  ]);
});

test('a link preview alone counts; a message without links gives nothing', () => {
  assert.deepEqual(extractLinks({ text: '', attaches: [{ _type: 'SHARE', url: 'https://ok.ru/video/1', title: 'Матч' }] }),
    [{ url: 'https://ok.ru/video/1', title: 'Матч' }]);
  assert.deepEqual(extractLinks({ text: 'тренировка в 10:00', attaches: [{ _type: 'PHOTO' }] }), []);
});

test('a link inside parentheses keeps its own brackets', () => {
  assert.deepEqual(extractLinks({ text: 'см. https://ru.wikipedia.org/wiki/Пример_(Тула).' }),
    [{ url: 'https://ru.wikipedia.org/wiki/Пример_(Тула)', title: null }]);
});

const rows = () => collectLinks([
  { id: '1', time: T0, sender: 42, text: 'смотри https://youtu.be/xyz', attaches: [] },
  { id: '2', time: T0 + 60_000, sender: 43, text: '=HYPERLINK("x") https://drive.example/a', attaches: [] },
  { id: '3', time: T0 + 120_000, sender: 42, text: 'без ссылок', attaches: [] },
], new Map([['42', 'Контакт']]), MSK);

test('collectLinks keeps every occurrence with date, sender and message text', () => {
  assert.deepEqual(rows().map((r) => [r.localTime, r.senderName, r.url]), [
    ['2026-10-18 19:30', 'Контакт', 'https://youtu.be/xyz'],
    ['2026-10-18 19:31', 'ID 43', 'https://drive.example/a'],
  ]);
});

test('CSV opens in Russian Excel: BOM, semicolons, quoted cells, no formulas', () => {
  const csv = renderLinksCsv(rows());
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], '"Дата";"Отправитель";"Ссылка";"Заголовок";"Сообщение"');
  assert.equal(lines[1], '"2026-10-18 19:30";"Контакт";"https://youtu.be/xyz";"";"смотри https://youtu.be/xyz"');
  assert.match(lines[2], /;"'=HYPERLINK\(""x""\) https:\/\/drive\.example\/a"$/);
});

test('HTML list links only web addresses and escapes everything else', () => {
  const html = renderLinksHtml({
    chat: { title: 'Пример чата <аналитика>' }, chatId: 1, exportedAt: T0, timeZone: MSK,
    rows: [
      { localTime: '2026-10-18 19:30', senderName: 'Контакт', url: 'https://youtu.be/xyz', title: 'Голы <тура>', text: 'смотри' },
      { localTime: '2026-10-18 19:31', senderName: 'Контакт', url: 'javascript:alert(1)', title: null, text: '' },
    ],
  });
  assert.match(html, /<a href="https:\/\/youtu\.be\/xyz"[^>]*>Голы &lt;тура&gt;<\/a>/);
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /Пример чата &lt;аналитика&gt;/);
  assert.match(html, /Ссылок: 2/);
});

test('browser shortcuts: one .url file per address, named by date and title, web addresses only', () => {
  const files = linkShortcuts([
    { time: T0, url: 'https://youtu.be/xyz', title: 'Голы: тура?' },
    { time: T0 + 60_000, url: 'https://youtu.be/xyz', title: null },
    { time: T0, url: 'https://drive.example/папка/отчёт?id=1', title: null },
    { time: T0, url: 'javascript:alert(1)', title: 'x' },
  ], MSK);
  assert.deepEqual(files.map((f) => f.path), [
    'Ссылки/2026-10-18_19-30-00_Голы_ тура_.url',
    'Ссылки/2026-10-18_19-30-00_drive.example папка отчёт.url',
  ]);
  assert.equal(files[0].text, '[InternetShortcut]\r\nURL=https://youtu.be/xyz\r\n');
  assert.equal(files[1].text, '[InternetShortcut]\r\nURL=https://drive.example/%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0/%D0%BE%D1%82%D1%87%D1%91%D1%82?id=1\r\n');
  assert.equal(files[0].time, T0);
});
