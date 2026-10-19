import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipWriter, addText, crc32 } from '../lib/zip.js';
import { readZip } from './read-zip.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const whole = crc32(new TextEncoder().encode('hello world'));
  const parts = crc32(new TextEncoder().encode(' world'), crc32(new TextEncoder().encode('hello')));
  assert.equal(parts, whole, 'incremental');
});

for (const zip64 of [false, true]) {
  test(`archive with Cyrillic names and Blob parts reads back${zip64 ? ' (ZIP64)' : ''}`, async () => {
    const zip = new ZipWriter({ zip64 });
    addText(zip, 'messages.html', '<h1>Контакт</h1>', Date.UTC(2026, 9, 18, 16, 30));
    const video = new TextEncoder().encode('кадр 1|кадр 2');
    zip.add('Видео/2026-10-18_19-30-00_тренировка.mp4', {
      parts: [new Blob([video.subarray(0, 7)]), new Blob([video.subarray(7)])], size: video.length, crc: crc32(video),
    });
    const buf = new Uint8Array(await zip.blob().arrayBuffer());
    const { files, zip64: found } = readZip(buf);
    assert.equal(found, zip64);
    assert.deepEqual(files.map((f) => [f.name, f.text]), [
      ['messages.html', '<h1>Контакт</h1>'],
      ['Видео/2026-10-18_19-30-00_тренировка.mp4', 'кадр 1|кадр 2'],
    ]);
  });
}
