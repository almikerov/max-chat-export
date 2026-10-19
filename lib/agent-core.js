import './protocol.js';
import { runExport } from './plan.js';
import { fetchNames } from './history.js';
import { localParts } from './attachments.js';

const { OPCODES, numberField } = globalThis.MceProtocol;
const QUICK_MS = 6000;
const LOG_LIMIT = 100;
const FIRST_POLL_MS = 200;

// Ядро агента во вкладке MAX: ведёт экспорт, пока вкладка открыта, даже если
// всплывающее окно закрыли, и отвечает окну. Браузерное передаётся снаружи:
//   page(type, extra, timeoutMs) → Promise — запрос к page-hook.js: 'status' | 'request' | 'diag'
//   background(msg) → Promise              — фону: 'archiveOpen' | 'archiveSave' | 'saveText' | 'downloadState'
//   offscreen(msg) → Promise               — скрытому документу, который собирает ZIP: 'zipFetch' | 'zipText' | 'zipDrop'
//   notify(state)                          — окну и значку: текущее состояние экспорта
export function createAgent({
  page, background, offscreen = async () => { throw new Error('сборка архива недоступна'); }, notify = () => {}, timeZone,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1500, now = () => Date.now(), delayMs,
}) {
  const state = {
    running: false, chatId: null, title: null, progress: null, log: [], summary: null, error: null, lastDownloadId: null,
    timeline: [], retries: 0,
  };
  const request = (opcode, payload) => page('request', { opcode, payload });
  // ID личного диалога = selfId XOR peerId; это НЕ ID собеседника.
  // Metadata comes from CHAT_INFO, not from a possibly empty history response.
  async function describeChat(chatId) {
    const deadline = Date.now() + QUICK_MS;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error('MAX не ответил за 6 с при определении чата');
      return ms;
    };
    const quick = (opcode, payload) => page('request', { opcode, payload, timeoutMs: remaining() });
    const response = await quick(OPCODES.CHAT_INFO, { chatIds: [numberField(chatId)] });
    const chat = response?.chats?.find((c) => String(c?.id) === chatId);
    if (!chat) throw new Error('MAX не вернул данные открытого чата');
    const result = { id: chatId, title: chat.title || null, type: chat.type ?? null };
    if (chat.type !== 'DIALOG' && (chat.type || !/^\d+$/.test(chatId))) return result;
    if (chatId === '0') return { ...result, title: 'Избранное' };

    // Captured from the logged-in session; no profile updates or extra logins.
    const status = await page('status', {}, remaining());
    const selfId = status?.userId === null || status?.userId === undefined ? '' : String(status.userId);
    if (!/^\d+$/.test(selfId)) throw new Error('MAX не передал ID вашего аккаунта — обновите вкладку MAX');
    const participants = Object.keys(chat.participants ?? {});
    const others = participants.filter((id) => id !== selfId);
    let peerId;
    if (others.length === 1) peerId = others[0];
    else if (!participants.length) peerId = String(BigInt(chatId) ^ BigInt(selfId));
    else throw new Error('не удалось однозначно определить собеседника MAX');
    const names = await fetchNames(quick, [peerId]);
    return { ...result, title: names.get(peerId) || chat.title || `Пользователь ${peerId}` };
  }

  // Фон стартует загрузку и сразу отвечает; завершение узнаём опросом —
  // так экспорт переживает засыпание фонового скрипта. Небольшие файлы скачиваются
  // за доли секунды, поэтому первый опрос быстрый, дальше интервал растёт до pollMs.
  async function waitDownload(id) {
    state.lastDownloadId = id;
    for (let wait = Math.min(FIRST_POLL_MS, pollMs); ; wait = Math.min(wait * 2, pollMs)) {
      await sleep(wait);
      const s = await background({ type: 'downloadState', id });
      if (s?.state === 'complete') return;
      if (s?.state === 'interrupted') throw new Error(s.error || 'загрузка прервана');
      if (!s || s.missing) throw new Error('загрузка пропала из списка загрузок');
    }
  }

  async function startDownload(msg) {
    const r = await background(msg);
    if (!r || r.error) throw new Error(r?.error ?? 'фон расширения не ответил');
    await waitDownload(r.id);
  }

  const writeText = (filename, text) => startDownload({ type: 'saveText', filename, text });

  const checked = (r) => {
    if (!r) throw new Error('расширение не ответило — обновите вкладку MAX');
    if (r.error) throw new Error(r.error);
    return r;
  };

  // Архив экспорта живёт в скрытом документе. Вложения идут туда напрямую,
  // готовый ZIP сохраняет фон — одной загрузкой.
  function makeArchive() {
    let opening = null;
    const id = () => {
      opening ??= background({ type: 'archiveOpen' }).then((r) => checked(r).id);
      return opening;
    };
    return {
      add: async (entry) => checked(await offscreen({ type: 'zipFetch', archive: await id(), ...entry })),
      text: async (path, text, time) => checked(await offscreen({ type: 'zipText', archive: await id(), path, text, time })),
      save: async (filename) => startDownload({ type: 'archiveSave', archive: await id(), filename }),
      drop: async () => {
        if (opening) await offscreen({ type: 'zipDrop', archive: await opening });
      },
    };
  }

  const snapshot = () => JSON.parse(JSON.stringify(state));

  function onProgress(p) {
    const { item, summary, ...progress } = p;
    state.progress = progress;
    if (progress.retry) state.retries++;
    if (state.timeline.at(-1)?.stage !== progress.stage) state.timeline.push({ stage: progress.stage, t: now() });
    if (item) {
      state.log.unshift({ kind: item.kind, name: item.name, size: item.size, status: item.status, error: item.error });
      state.log.length = Math.min(state.log.length, LOG_LIMIT);
    }
    if (summary) state.summary = summary;
    notify(snapshot());
  }

  function start({ chatId, title, options }) {
    if (state.running) throw new Error('экспорт уже идёт');
    Object.assign(state, {
      running: true, chatId, title, progress: { stage: 'history', count: 0 }, log: [], summary: null, error: null,
      timeline: [], retries: 0,
    });
    notify(snapshot());
    const done = runExport({
      request, archive: makeArchive(), options, timeZone, onProgress, sleep,
      chatId: numberField(String(chatId)), chatTitle: title, now: now(), ...(delayMs !== undefined ? { delayMs } : {}),
    })
      .catch((error) => { state.error = error.message; })
      .finally(() => {
        state.running = false;
        notify(snapshot());
      });
    return done;
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'status': {
        let pageStatus = null;
        let pageError = null;
        try {
          pageStatus = await page('status', {}, 5000);
        } catch (error) {
          pageError = error.message;
        }
        return { page: pageStatus, pageError, export: snapshot() };
      }
      case 'chat':
        try {
          return await describeChat(String(msg.chatId));
        } catch (error) {
          return { id: String(msg.chatId), title: null, type: null, error: error.message };
        }
      case 'start':
        start(msg);
        return { started: true };
      case 'diag': {
        const data = await page('diag', {}, 10000);
        // По времени этапов видно, где экспорт теряет время, по retries — сколько раз рвалась связь.
        const { running, progress, error, summary, timeline, retries } = state;
        data.export = { running, progress, error, summary, timeline, retries };
        const { date, time } = localParts(now(), timeZone);
        await writeText(`Max-Chat-Export/diagnostics_${date}_${time}.json`, JSON.stringify(data, null, 2));
        return { saved: true, downloadId: state.lastDownloadId };
      }
      default:
        throw new Error(`неизвестная команда: ${msg.type}`);
    }
  }

  return { handle, state, start };
}
