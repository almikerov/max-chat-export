import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInto, withExtension } from '../lib/archive.js';
import { crc32 } from '../lib/zip.js';

function fakeZip() {
  const added = [];
  return { added, add: (name, entry) => added.push({ name, ...entry }) };
}

function response(chunks, { status = 200, type = 'application/octet-stream' } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': type } });
}

const text = async (parts) => new TextDecoder().decode(await new Blob(parts).arrayBuffer());

test('a file streams into the archive with its size and CRC', async () => {
  const zip = fakeZip();
  const r = await fetchInto(zip, { path: 'Файлы/2026-10-18_19-31-00_Document.xlsx', url: 'https://fd.oneme.ru/f/1', time: 5 },
    { fetch: async () => response(['отчёт ', 'Document']) });
  assert.deepEqual(r, { path: 'Файлы/2026-10-18_19-31-00_Document.xlsx', size: 19 });
  const [entry] = zip.added;
  assert.equal(await text(entry.parts), 'отчёт Document');
  assert.equal(entry.crc, crc32(new TextEncoder().encode('отчёт Document')));
  assert.equal(entry.time, 5);
});

test('photos are converted to the chosen format and named by it', async () => {
  for (const [format, mime, ext] of [['jpg', 'image/jpeg', '.jpg'], ['png', 'image/png', '.png']]) {
    const zip = fakeZip();
    const converted = [];
    const r = await fetchInto(zip, { path: 'Фото/2026-10-18_19-32-00_photo_7.jpg', url: 'u', image: format }, {
      fetch: async () => response(['webp-bytes'], { type: 'image/webp' }),
      convertImage: async (blob, to) => { converted.push([await blob.text(), to]); return new Blob([`as ${to}`]); },
    });
    assert.deepEqual(converted, [['webp-bytes', mime]]);
    assert.equal(r.path, `Фото/2026-10-18_19-32-00_photo_7${ext}`);
    assert.equal(await text(zip.added[0].parts), `as ${mime}`);
    assert.equal(zip.added[0].crc, crc32(new TextEncoder().encode(`as ${mime}`)));
  }
});

test('a photo already in the chosen format is kept as is; the original format follows the server type', async () => {
  const convertImage = async () => assert.fail('no conversion');
  const jpeg = fakeZip();
  await fetchInto(jpeg, { path: 'Фото/a_photo_1.jpg', url: 'u', image: 'jpg' },
    { fetch: async () => response(['jpeg'], { type: 'image/jpeg; charset=binary' }), convertImage });
  assert.equal(await text(jpeg.added[0].parts), 'jpeg');
  const original = fakeZip();
  const r = await fetchInto(original, { path: 'Фото/a_photo_1.jpg', url: 'u', image: 'original' },
    { fetch: async () => response(['webp'], { type: 'image/webp' }), convertImage });
  assert.equal(r.path, 'Фото/a_photo_1.webp', 'the HTML link matches the saved file');
});

test('an HTTP error is reported and nothing is added', async () => {
  const zip = fakeZip();
  await assert.rejects(fetchInto(zip, { path: 'Видео/v.mp4', url: 'u' }, { fetch: async () => response([], { status: 403 }) }), /HTTP 403/);
  assert.equal(zip.added.length, 0);
});

test('withExtension replaces only the file extension', () => {
  assert.equal(withExtension('Фото/2026-10-18_19-32-00_photo_7.jpg', '.png'), 'Фото/2026-10-18_19-32-00_photo_7.png');
  assert.equal(withExtension('Фото/v1.2/photo', '.jpg'), 'Фото/v1.2/photo.jpg');
});
