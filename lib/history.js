import './protocol.js';

const { OPCODES } = globalThis.MceProtocol;
const MAX_PAGES = 20000;
// Чем больше пачка, тем меньше запросов. Сколько максимум отдаёт MAX, не документировано:
// пробуем 1000, при отказе — 200, затем 50. Сервер может и сам урезать пачку — это не ошибка.
const PAGE_SIZES = [1000, 200, 50];

// Листает историю чата назад от `toMs` до `fromMs`.
// После первой принятой пачки ошибки с размером уже не связаны и уходят наверх.
// request(opcode, payload) → payload ответа.
// Возвращает { chat, messages, stats } — сообщения по возрастанию времени, без дублей;
// stats — сколько запросов, какой пачкой и за сколько миллисекунд.
export async function fetchHistory(request, chatId, { fromMs = 0, toMs = Date.now(), pageSize, onPage = () => {}, now = Date.now } = {}) {
  const sizes = pageSize ? [pageSize] : PAGE_SIZES;
  const started = now();
  const seen = new Map();
  let chat = null;
  let cursor = toMs;
  let level = 0;
  let sizeAccepted = false;
  let pages = 0;
  let largestPage = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const ask = () => request(OPCODES.HISTORY, {
      chatId,
      from: cursor,
      forward: 0,
      backward: sizes[level],
      backwardTime: 0,
      forwardTime: 0,
      getChat: page === 0,
      getMessages: true,
      interactive: false,
    });
    let response;
    for (;;) {
      try {
        response = await ask();
        break;
      } catch (error) {
        if (sizeAccepted || level === sizes.length - 1) throw error;
        level++;
      }
    }
    sizeAccepted = true;
    pages++;
    if (page === 0) chat = response?.chat ?? null;

    const messages = response?.messages ?? [];
    largestPage = Math.max(largestPage, messages.length);
    let added = 0;
    let oldest = Infinity;
    for (const message of messages) {
      oldest = Math.min(oldest, message.time);
      const id = String(message.id);
      if (!seen.has(id)) {
        seen.set(id, message);
        added++;
      }
    }
    onPage(seen.size);
    // Конец истории: пустая пачка, одни повторы или вышли за начало периода.
    if (!messages.length || !added || oldest < fromMs) break;
    cursor = oldest;
  }

  const messages = [...seen.values()]
    .filter((m) => m.time >= fromMs && m.time <= toMs)
    .sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));
  const stats = { pages, pageSize: sizes[level], largestPage, messages: messages.length, ms: now() - started };
  return { chat, messages, stats };
}

// CUSTOM — имя, сохранённое владельцем аккаунта, ONEME — публичный профиль.
// Both name shapes are used by MAX: {name} and {firstName, lastName}.
export function contactName(contact) {
  const list = Array.isArray(contact?.names) ? contact.names.filter((n) => n && typeof n === 'object') : [];
  const clean = (value) => typeof value === 'string' ? value.trim() : '';
  const display = (n) => {
    const first = clean(n.firstName);
    const last = clean(n.lastName);
    return last || !clean(n.name) ? [first, last].filter(Boolean).join(' ') : clean(n.name);
  };
  for (const type of ['CUSTOM', 'ONEME', 'FULL_NAME']) {
    for (const entry of list.filter((n) => n.type === type)) {
      const name = display(entry);
      if (name) return name;
    }
  }
  const split = ['FIRST_NAME', 'LAST_NAME'].map((type) => clean(list.find((n) => n.type === type)?.name)).filter(Boolean).join(' ');
  return split || list.map(display).find(Boolean) || null;
}

// Имена любых пользователей по ID (опкод 32), в том числе вне контактов.
// Телефоны и прочее не сохраняем.
export async function fetchNames(request, userIds, { chunk = 100 } = {}) {
  const names = new Map();
  const ids = [...new Set(userIds.filter((id) => id !== null && id !== undefined).map(String))];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const response = await request(OPCODES.CONTACTS, {
      contactIds: part.map(globalThis.MceProtocol.numberField),
    });
    for (const contact of response?.contacts ?? []) {
      const name = contactName(contact);
      if (name && contact.id !== null && contact.id !== undefined && ids.includes(String(contact.id))) names.set(String(contact.id), name);
    }
  }
  return names;
}
