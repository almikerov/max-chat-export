// Поддельный сервер MAX: отвечает на опкоды 48, 49, 53, 32, 88, 83.
import '../lib/protocol.js';

const { OPCODES } = globalThis.MceProtocol;

export const T0 = Date.UTC(2026, 9, 18, 16, 30, 0); // 18.10.2026 19:30 МСК

export function makeMessages(count, { start = T0, step = 60_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(116762160362694583n + BigInt(i)),
    time: start + i * step,
    type: 'USER',
    sender: i % 2 ? 3260456 : 9000000000003,
    text: `сообщение ${i}`,
    attaches: [],
  }));
}

export function fakeMax(messages, { chat = { id: -72013736853616, title: 'Пример чата' }, chats = [], failFileIds = [] } = {}) {
  const calls = [];
  const request = async (opcode, payload) => {
    calls.push({ opcode, payload });
    switch (opcode) {
      case OPCODES.CHAT_INFO:
        return { chats: payload.chatIds.map((id) => ({ ...chat, id })) };
      case OPCODES.HISTORY: {
        const older = messages.filter((m) => m.time <= payload.from).sort((a, b) => a.time - b.time);
        const page = older.slice(Math.max(0, older.length - payload.backward));
        return { messages: page, ...(payload.getChat ? { chat } : {}) };
      }
      case 53: {
        const older = chats.filter((c) => (c.lastMessage?.time ?? 0) < payload.marker)
          .sort((a, b) => b.lastMessage.time - a.lastMessage.time).slice(0, payload.count);
        return { chats: older, marker: older.length ? older.at(-1).lastMessage.time : payload.marker };
      }
      case OPCODES.CONTACTS:
        return {
          contacts: payload.contactIds.map((id) => ({
            id, names: [{ name: { 3260456: 'Тренер', 9000000000003: 'Видеоаналитик', 777: 'Врач команды' }[id] ?? `Игрок ${id}`, type: 'FULL_NAME' }], phones: [{ number: '+70000000000' }],
          })),
        };
      case OPCODES.FILE_URL:
        if (failFileIds.includes(String(payload.fileId))) throw new Error('FILE_NOT_FOUND');
        return { url: `https://fd.oneme.ru/f/${payload.fileId}`, unsafe: false };
      case OPCODES.VIDEO_URL:
        return { EXTERNAL: 'https://m.ok.ru/video/1', cache: true, MP4_480: 'https://cdn/480.mp4', MP4_1080: 'https://cdn/1080.mp4' };
      default:
        throw new Error(`unexpected opcode ${opcode}`);
    }
  };
  return { request, calls };
}
