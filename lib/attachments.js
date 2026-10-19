// Вложения сообщений MAX: какие бывают, как называть файлы, что выгружать.

export const KINDS = {
  photo: { type: 'PHOTO', label: 'Фото' },
  video: { type: 'VIDEO', label: 'Видео' },
  file: { type: 'FILE', label: 'Файлы' },
  audio: { type: 'AUDIO', label: 'Голосовые' },
};
const KIND_BY_TYPE = Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [k.type, kind]));

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MAX_NAME = 120;

// Имя, безопасное для Windows и chrome.downloads.
export function sanitizeName(name, fallback = 'file') {
  let clean = String(name ?? '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  clean = clean.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) clean = fallback;
  if (RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > MAX_NAME) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
    clean = clean.slice(0, MAX_NAME - ext.length).trimEnd() + ext;
  }
  return clean;
}

function extensionFromUrl(url) {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? `.${m[1].toLowerCase()}` : '';
  } catch {
    return '';
  }
}

// Описание вложения: id, имя файла, размер (если известен).
export function describe(kind, attach) {
  switch (kind) {
    case 'photo':
      return { id: attach.photoId, name: `photo_${attach.photoId}.jpg`, size: null };
    case 'video':
      return { id: attach.videoId, name: `video_${attach.videoId}.mp4`, size: null };
    case 'file': {
      const id = attach.fileId;
      return { id, name: attach.name ?? attach.fileName ?? `file_${id}`, size: attach.size ?? attach.fileSize ?? null };
    }
    case 'audio':
      return { id: attach.audioId, name: `voice_${attach.audioId}${extensionFromUrl(attach.url) || '.ogg'}`, size: null };
    default:
      return null;
  }
}

// Части даты и времени в нужном часовом поясе (по умолчанию — пояс браузера).
export function localParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}-${p.minute}-${p.second}` };
}

// Все вложения сообщений → элементы плана экспорта.
// options: { kinds: ['photo', ...], maxBytes: number|null, timeZone }
export function selectAttachments(messages, { kinds = Object.keys(KINDS), maxBytes = null, timeZone } = {}) {
  const wanted = new Set(kinds);
  const usedPaths = new Set();
  const items = [];

  for (const message of messages) {
    (message.attaches ?? []).forEach((attach, index) => {
      const kind = KIND_BY_TYPE[attach?._type];
      if (!kind) return;
      const info = describe(kind, attach);
      const item = { message, attach, index, kind, id: info.id, name: info.name, size: info.size, path: null, status: 'pending', error: null };

      if (!wanted.has(kind)) item.status = 'skipped-type';
      else if (maxBytes && info.size && info.size > maxBytes) item.status = 'skipped-size';
      else {
        const { date, time } = localParts(message.time, timeZone);
        const base = sanitizeName(info.name, `${kind}_${info.id}`);
        const folder = KINDS[kind].label;
        let path = `${folder}/${date}_${time}_${base}`;
        for (let n = 2; usedPaths.has(path.toLowerCase()); n++) {
          const dot = base.lastIndexOf('.');
          const numbered = dot > 0 ? `${base.slice(0, dot)}_${n}${base.slice(dot)}` : `${base}_${n}`;
          path = `${folder}/${date}_${time}_${numbered}`;
        }
        usedPaths.add(path.toLowerCase());
        item.path = path;
      }
      items.push(item);
    });
  }
  return items;
}
