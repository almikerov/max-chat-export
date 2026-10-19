import { ZipWriter, addText, crc32 } from './zip.js';

// Вложение скачивается прямо в архив: данные идут потоком, CRC считается на лету,
// а куски складываются в Blob по 8 МБ — большое видео не держится в памяти JS.
const BATCH = 8 * 1024 * 1024;
const IMAGE = { jpg: { mime: 'image/jpeg', ext: '.jpg' }, png: { mime: 'image/png', ext: '.png' } };
const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/avif': '.avif', 'image/bmp': '.bmp',
};

export function withExtension(path, ext) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return (dot > slash ? path.slice(0, dot) : path) + ext;
}

async function collect(stream) {
  const parts = [];
  let batch = [];
  let batched = 0;
  let size = 0;
  let crc = 0;
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32(value, crc);
      size += value.length;
      batch.push(value);
      batched += value.length;
      if (batched >= BATCH) {
        parts.push(new Blob(batch));
        batch = [];
        batched = 0;
      }
    }
  }
  if (batch.length) parts.push(new Blob(batch));
  return { parts, size, crc };
}

// image: 'jpg' | 'png' — перевести фото в этот формат; 'original' — как отдал MAX
// (расширение по типу ответа); null — не фото. Возвращает итоговый путь и размер.
export async function fetchInto(zip, { path, url, time, image = null }, { fetch = globalThis.fetch, convertImage } = {}) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (image) {
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const target = IMAGE[image];
    if (target && type !== target.mime) {
      const converted = await convertImage(await response.blob(), target.mime);
      const data = new Uint8Array(await converted.arrayBuffer());
      path = withExtension(path, target.ext);
      zip.add(path, { parts: [data], size: data.length, crc: crc32(data), time });
      return { path, size: data.length };
    }
    const ext = target?.ext ?? EXT_BY_MIME[type];
    if (ext) path = withExtension(path, ext);
  }
  const { parts, size, crc } = await collect(response.body);
  zip.add(path, { parts, size, crc, time });
  return { path, size };
}

// Обработчик команд архива в скрытом документе. Браузерное (fetch, перевод фото,
// blob-URL) передаётся снаружи — так тот же код проверяется в Node.
// Возвращает null на чужие команды.
export function createArchiveService({ fetch = globalThis.fetch, convertImage, createUrl = (blob) => URL.createObjectURL(blob) } = {}) {
  const archives = new Map();
  let nextId = 1;
  const get = (id) => {
    const zip = archives.get(id);
    if (!zip) throw new Error('архив экспорта потерян — повторите экспорт');
    return zip;
  };
  return async function handle(msg) {
    switch (msg.type) {
      case 'zipOpen': {
        const id = nextId++;
        archives.set(id, new ZipWriter());
        return { id };
      }
      case 'zipFetch':
        return fetchInto(get(msg.archive), msg, { fetch, convertImage });
      case 'zipText':
        addText(get(msg.archive), msg.path, msg.text, msg.time);
        return { path: msg.path };
      case 'zipClose': {
        const url = createUrl(get(msg.archive).blob());
        archives.delete(msg.archive);
        return { url };
      }
      case 'zipDrop':
        archives.delete(msg.archive);
        return {};
      default:
        return null;
    }
  };
}
