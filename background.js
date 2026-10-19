// Фон расширения: сохранение архива и текстовых файлов, значок с прогрессом.
// Архив собирает скрытый документ (offscreen.js); фон открывает его и отдаёт готовый ZIP в загрузки.
const OFFSCREEN_URL = 'offscreen.html';
const blobUrls = new Map(); // id загрузки → blob-URL, который надо освободить

const MIME = { html: 'text/html', json: 'application/json' };
const mimeFor = (filename) => `${MIME[filename.split('.').pop()] ?? 'text/plain'};charset=utf-8`;

let creatingOffscreen = null;

// Blob-URL создаёт скрытый документ: в фоновом скрипте URL.createObjectURL нет.
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing?.length) return true;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ['BLOBS'], justification: 'Сохранение истории чата в файл' })
    .catch((error) => {
      if (!/single offscreen/i.test(error.message)) throw error;
    })
    .finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
  return true;
}

// Запасной путь без offscreen: data-URL (до ~2 МБ).
function toDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

const startDownload = (url, filename) => chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });

async function saveText({ filename, text }) {
  const mime = mimeFor(filename);
  const url = (await ensureOffscreen())
    ? await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob', text, mime })
    : toDataUrl(text, mime);
  const id = await startDownload(url, filename);
  if (url.startsWith('blob:')) blobUrls.set(id, url);
  return { id };
}

async function archiveOpen() {
  if (!(await ensureOffscreen())) throw new Error('браузер не поддерживает сборку архива (offscreen)');
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'zipOpen' });
}

async function archiveSave({ archive, filename }) {
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'zipClose', archive });
  if (!r || r.error) throw new Error(r?.error ?? 'архив не собран');
  const id = await startDownload(r.url, filename);
  blobUrls.set(id, r.url);
  return { id };
}

async function downloadState({ id }) {
  const [item] = await chrome.downloads.search({ id });
  if (!item) return { missing: true };
  if (item.state !== 'in_progress' && blobUrls.has(id)) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url: blobUrls.get(id) }).catch(() => {});
    blobUrls.delete(id);
  }
  return { state: item.state, error: item.error ?? null };
}

async function handle(msg) {
  switch (msg.type) {
    case 'archiveOpen':
      return archiveOpen();
    case 'archiveSave':
      return archiveSave(msg);
    case 'saveText':
      return saveText(msg);
    case 'downloadState':
      return downloadState(msg);
    case 'show':
      chrome.downloads.show(msg.id);
      return {};
    default:
      throw new Error(`неизвестная команда фона: ${msg.type}`);
  }
}

function showOnBadge(state) {
  let text = '';
  let color = '#2f6fed';
  if (state.running) {
    const p = state.progress;
    text = p?.stage === 'files' && p.total ? `${Math.floor((100 * p.done) / p.total)}%` : '…';
  } else if (state.error) {
    text = '!';
    color = '#b3261e';
  } else if (state.summary) {
    text = '✓';
    color = '#1e7f3e';
  }
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'progress') {
    showOnBadge(msg.state);
    return false;
  }
  if (msg?.target !== 'background') return false;
  handle(msg).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});
