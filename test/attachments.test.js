import test from 'node:test';
import assert from 'node:assert/strict';
import { localParts, sanitizeName, selectAttachments } from '../lib/attachments.js';
import { T0 } from './fake-max.js';

const MSK = 'Europe/Moscow';

test('sanitizeName makes Windows-safe names', () => {
  assert.equal(sanitizeName('Отчёт: тренировка 18/10?.xlsx'), 'Отчёт_ тренировка 18_10_.xlsx');
  assert.equal(sanitizeName('  ..скрытый.  '), 'скрытый');
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName(''), 'file');
  const long = sanitizeName(`${'я'.repeat(200)}.mp4`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.mp4'));
});

test('localParts formats in the given time zone', () => {
  assert.deepEqual(localParts(T0, MSK), { date: '2026-10-18', time: '19-30-00' });
});

const message = (attaches, time = T0) => ({ id: '116762160362694583', time, sender: 1, attaches });

test('selectAttachments maps MAX attach types into one folder per type with dated names', () => {
  const items = selectAttachments([message([
    { _type: 'PHOTO', photoId: 11, baseUrl: 'https://i.oneme.ru/i?r=1' },
    { _type: 'VIDEO', videoId: 22, token: 't' },
    { _type: 'FILE', fileId: 33, name: 'Document 18.10.xlsx', size: 2048 },
    { _type: 'AUDIO', audioId: 44, url: 'https://au.oneme.ru/a/44.m4a' },
    { _type: 'STICKER', stickerId: 55 },
    { _type: 'CONTROL', action: 'botStarted' },
  ])], { timeZone: MSK });
  assert.deepEqual(items.map((i) => [i.kind, i.path]), [
    ['photo', 'Фото/2026-10-18_19-30-00_photo_11.jpg'],
    ['video', 'Видео/2026-10-18_19-30-00_video_22.mp4'],
    ['file', 'Файлы/2026-10-18_19-30-00_Document 18.10.xlsx'],
    ['audio', 'Голосовые/2026-10-18_19-30-00_voice_44.m4a'],
  ]);
  assert.ok(items.every((i) => i.status === 'pending'));
});

test('selectAttachments filters by type and size limit', () => {
  const items = selectAttachments([message([
    { _type: 'PHOTO', photoId: 11, baseUrl: 'u' },
    { _type: 'FILE', fileId: 33, name: 'small.pdf', size: 1000 },
    { _type: 'FILE', fileId: 34, name: 'big.zip', size: 5_000_000 },
  ])], { kinds: ['file'], maxBytes: 1_000_000, timeZone: MSK });
  assert.deepEqual(items.map((i) => [i.name, i.status, i.path === null]), [
    ['photo_11.jpg', 'skipped-type', true],
    ['small.pdf', 'pending', false],
    ['big.zip', 'skipped-size', true],
  ]);
});

test('selectAttachments numbers files with the same name in the same second', () => {
  const items = selectAttachments([
    message([{ _type: 'FILE', fileId: 1, name: 'report.pdf', size: 1 }]),
    { ...message([{ _type: 'FILE', fileId: 2, name: 'Report.pdf', size: 1 }]), id: '2' },
  ], { timeZone: MSK });
  assert.deepEqual(items.map((i) => i.path), ['Файлы/2026-10-18_19-30-00_report.pdf', 'Файлы/2026-10-18_19-30-00_Report_2.pdf']);
});
