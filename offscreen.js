// Скрытый документ расширения: blob-URL для текстовых файлов и сборка ZIP-архива экспорта.
// Здесь есть fetch с правами расширения (CDN MAX без CORS страницы), Blob и OffscreenCanvas.
// Агент во вкладке MAX пишет сюда напрямую (target: 'offscreen'), минуя фоновый скрипт:
// долгая загрузка видео не зависит от засыпания service worker.
import { createArchiveService } from './lib/archive.js';

async function convertImage(blob, mime) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  // В JPG нет прозрачности: прозрачные места — белые, а не чёрные.
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: mime, quality: 0.92 });
}

const archive = createArchiveService({ convertImage });

async function handle(msg) {
  if (msg.type === 'blob') return URL.createObjectURL(new Blob([msg.text], { type: msg.mime }));
  if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.url);
    return true;
  }
  const result = await archive(msg);
  if (result === null) throw new Error(`неизвестная команда: ${msg.type}`);
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handle(msg).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});
