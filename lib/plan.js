import './protocol.js';
import { fetchHistory, fetchNames } from './history.js';
import { localParts, sanitizeName, selectAttachments } from './attachments.js';
import { renderHtml, renderJson, renderReport } from './render.js';
import { collectLinks, linkShortcuts, renderLinksCsv, renderLinksHtml } from './links.js';
import { compileFilters } from './filters.js';

const { OPCODES, numberField, pickVideoUrl } = globalThis.MceProtocol;

// Запросы к MAX — строго по одному: следующий уходит после ответа на предыдущий.
// Пауза между ними по умолчанию не нужна, параметр оставлен для подстройки.
export function throttle(request, delayMs, sleep) {
  let chain = Promise.resolve();
  let last = 0;
  return (opcode, payload) => {
    const run = chain.then(async () => {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await request(opcode, payload);
      } finally {
        last = Date.now();
      }
    });
    chain = run.catch(() => {});
    return run;
  };
}

// Обрыв соединения MAX, молчание сервера и ограничение частоты временны: приложение
// само переподключается, лимит проходит. Остальные ошибки MAX (файл не найден и т.п.) не повторяем.
const TRANSIENT = /соединение MAX закрыто|не ответил за|не удалось подключиться|переподключ|too.?many|rate.?limit|flood|слишком много|слишком часто/i;
const RETRY_PAUSES_MS = [2000, 5000, 10000, 20000];

export function retrying(request, sleep, onRetry = () => {}, pauses = RETRY_PAUSES_MS) {
  return async (opcode, payload) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(opcode, payload);
      } catch (error) {
        if (attempt >= pauses.length || !TRANSIENT.test(error?.message ?? '')) throw error;
        onRetry(attempt + 1);
        await sleep(pauses[attempt]);
      }
    }
  };
}

// MAX отверг сам формат запроса: тот же запрос для другого вложения отвергнет так же,
// а каждый такой отказ может стоить переподключения MAX. Остальные запросы с этим
// опкодом сразу получают ту же ошибку. Проверка — в момент отправки, после очереди.
const FORMAT_REJECTED = /proto\.(payload|opcode)/;

export function breaker(request, opcodes) {
  const rejected = new Map();
  return async (opcode, payload) => {
    if (rejected.has(opcode)) throw new Error(rejected.get(opcode));
    try {
      return await request(opcode, payload);
    } catch (error) {
      if (opcodes.includes(opcode) && FORMAT_REJECTED.test(error?.message ?? '')) rejected.set(opcode, error.message);
      throw error;
    }
  };
}

// Прямая ссылка на вложение: фото и голосовые — из истории, файлы и видео — запросом.
export async function resolveUrl(request, chatId, item) {
  const { attach, message } = item;
  switch (item.kind) {
    case 'photo':
      if (!attach.baseUrl) throw new Error('нет ссылки на фото');
      return attach.baseUrl;
    case 'audio':
      if (!attach.url) throw new Error('нет ссылки на голосовое');
      return attach.url;
    case 'file': {
      // В двоичном протоколе MAX messageId — число (Long), строку сервер отвергает.
      const response = await request(OPCODES.FILE_URL, { chatId, messageId: numberField(String(message.id)), fileId: numberField(String(attach.fileId)) });
      if (!response?.url) throw new Error('сервер не дал ссылку на файл');
      return response.url;
    }
    case 'video': {
      const response = await request(OPCODES.VIDEO_URL, {
        chatId, messageId: numberField(String(message.id)), videoId: numberField(String(attach.videoId)), token: attach.token ?? '',
      });
      const url = pickVideoUrl(response);
      if (!url) throw new Error(response?.EXTERNAL ? 'видео доступно только во внешнем плеере' : 'сервер не дал ссылку на видео');
      return url;
    }
    default:
      throw new Error(`неизвестный тип вложения ${item.kind}`);
  }
}

function isService(message) {
  return (message.attaches ?? []).some((a) => a?._type === 'CONTROL');
}

// Полный экспорт чата в один ZIP. Всё, что касается браузера, передаётся снаружи:
//   request(opcode, payload) → payload            — запрос к MAX
//   archive.add({ path, url, time, image }) → { path, size } — скачать вложение в архив
//   archive.text(path, text, time) → Promise      — положить текстовый файл в архив
//   archive.save(filename) → Promise               — сохранить архив в загрузки (резолвится по завершении)
//   archive.drop() → Promise                       — выбросить недособранный архив
// options: { formats: { html, json }, kinds, fileTypes: ['pdf' | 'word' | 'excel' | 'other'], fromMs, toMs, maxBytes,
//            imageFormat: 'jpg' | 'png' | 'original', links: { html, csv, shortcuts } — отдельный список ссылок и ярлыки,
//            filters: { messages, links, photo, video, file, audio } — RegEx строк, senders: ['id', …] | null }
export async function runExport({
  request, archive, chatId, chatTitle = null, options,
  now = Date.now(), timeZone, onProgress = () => {},
  delayMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), concurrency = 4,
}) {
  const startedAt = now;
  let current = null;
  const report = (p) => {
    const { item, summary, ...rest } = p;
    current = rest;
    onProgress(p);
  };
  // Пока MAX переподключается, окно показывает, что экспорт ждёт, а не завис.
  const ask = throttle(breaker(retrying(request, sleep, (retry) => onProgress({ ...current, retry })),
    [OPCODES.FILE_URL, OPCODES.VIDEO_URL]), delayMs, sleep);
  const imageFormat = options.imageFormat ?? 'jpg';

  try {
    // Ошибку в фильтре видно сразу, до чтения истории.
    const filters = compileFilters(options.filters);
    const senders = Array.isArray(options.senders) ? new Set(options.senders.map(String)) : null;

    report({ stage: 'history', count: 0 });
    const { chat: chatInfo, messages: all, stats: history } = await fetchHistory(ask, chatId, {
      fromMs: options.fromMs ?? 0,
      toMs: options.toMs ?? now,
      onPage: (count) => report({ stage: 'history', count }),
    });
    // Выбранные отправители ограничивают всё: историю, ссылки и вложения.
    const messages = all.filter((m) => !isService(m) && (!senders || senders.has(String(m.sender))));
    // У личных диалогов в истории нет названия — берём то, что показали пользователю в списке.
    const chat = { ...chatInfo, title: chatTitle || chatInfo?.title || null };

    report({ stage: 'names' });
    const names = await fetchNames(ask, messages.map((m) => m.sender));

    let links = options.links?.html || options.links?.csv || options.links?.shortcuts ? collectLinks(messages, names, timeZone) : null;
    if (links && filters.links) links = links.filter((r) => filters.links.test(`${r.title ?? ''} ${r.url}`));
    const items = selectAttachments(messages, { kinds: options.kinds, fileTypes: options.fileTypes, filters, maxBytes: options.maxBytes, timeZone });
    // Фильтр сообщений — по тексту; он решает, что попадёт в историю HTML/JSON.
    const shown = filters.messages ? messages.filter((m) => filters.messages.test(m.text ?? '')) : messages;
    const { date, time } = localParts(now, timeZone);
    const archiveName = `Max-Chat-Export/${sanitizeName(chat.title ?? `chat_${chatId}`)}_${date}_${time.slice(0, 5)}.zip`;

    const queue = items.filter((i) => i.status === 'pending');
    const total = queue.length;
    let done = 0;
    report({ stage: 'files', done, total });
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const url = await resolveUrl(ask, chatId, item);
          const saved = await archive.add({ path: item.path, url, time: item.message.time, image: item.kind === 'photo' ? imageFormat : null });
          // Путь может смениться: фото в выбранном формате получает своё расширение.
          item.path = saved.path;
          item.size ??= saved.size ?? null;
          item.status = 'ok';
        } catch (error) {
          item.status = 'failed';
          item.error = error?.message ?? String(error);
        }
        done++;
        report({ stage: 'files', done, total, item });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

    report({ stage: 'writing' });
    const context = { chat, chatId, messages: shown, names, items, options, exportedAt: now, timeZone };
    if (options.formats?.html) await archive.text('messages.html', renderHtml(context), now);
    if (options.formats?.json) await archive.text('messages.json', renderJson(context), now);
    if (options.links?.html) await archive.text('links.html', renderLinksHtml({ chat, chatId, rows: links, exportedAt: now, timeZone }), now);
    if (options.links?.csv) await archive.text('links.csv', renderLinksCsv(links), now);
    if (options.links?.shortcuts) {
      for (const shortcut of linkShortcuts(links, timeZone)) await archive.text(shortcut.path, shortcut.text, shortcut.time);
    }
    const finishedAt = Date.now();
    await archive.text('report.txt', renderReport({
      ...context, archive: archiveName, history, links: links?.length ?? null,
      messagesTotal: messages.length, senders: senders?.size ?? null, startedAt, finishedAt,
    }), now);
    await archive.save(archiveName);

    const summary = {
      archive: archiveName,
      title: chat?.title ?? null,
      messages: shown.length,
      downloaded: items.filter((i) => i.status === 'ok').length,
      failed: items.filter((i) => i.status === 'failed').length,
      skipped: items.filter((i) => i.status.startsWith('skipped')).length,
      history,
      links: links?.length ?? null,
    };
    report({ stage: 'done', summary });
    return { ...summary, items };
  } catch (error) {
    await archive.drop?.().catch(() => {});
    throw error;
  }
}
