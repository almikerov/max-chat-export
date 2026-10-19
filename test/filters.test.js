import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilters } from '../lib/filters.js';
import { selectAttachments } from '../lib/attachments.js';
import { T0 } from './fake-max.js';

test('filters are case-insensitive regular expressions; empty ones are ignored', () => {
  const f = compileFilters({ messages: 'тренировк', file: '^отч[её]т', photo: '  ', video: '' });
  assert.deepEqual(Object.keys(f).sort(), ['file', 'messages']);
  assert.ok(f.messages.test('Завтра ТРЕНИРОВКА в 10'));
  assert.ok(f.file.test('Отчет 14.10.26 ВЕЧЕР.pdf'));
  assert.ok(!f.file.test('Вес.docx'));
});

test('a broken filter names its row', () => {
  assert.throws(() => compileFilters({ file: '([' }), /неверный фильтр «Файлы»/);
});

test('attachments that do not match their row filter are skipped by filter', () => {
  const items = selectAttachments([{ id: '1', time: T0, sender: 1, attaches: [
    { _type: 'FILE', fileId: 1, name: 'Отчет 14.10.26 ВЕЧЕР.pdf', size: 10 },
    { _type: 'FILE', fileId: 2, name: 'Вес.docx', size: 10 },
    { _type: 'PHOTO', photoId: 3, baseUrl: 'u' },
  ] }], { filters: compileFilters({ file: 'отчет' }), timeZone: 'Europe/Moscow' });
  assert.deepEqual(items.map((i) => [i.name, i.status]), [
    ['Отчет 14.10.26 ВЕЧЕР.pdf', 'pending'], ['Вес.docx', 'skipped-filter'], ['photo_3.jpg', 'pending'],
  ]);
});
