// Агент во вкладке MAX с поддельными страницей и фоном расширения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../lib/agent-core.js';
import { fakeMax, makeMessages } from './fake-max.js';
import { fakeExtension } from './fake-extension.js';

function setup({ failUrl = null, silent = false, chat } = {}) {
  const messages = makeMessages(3);
  messages[1].attaches = [{ _type: 'FILE', fileId: 501, name: 'Document.xlsx', size: 4096 }];
  messages[2].attaches = [{ _type: 'VIDEO', videoId: 9, token: 't' }];
  const { request } = fakeMax(messages, chat ? { chat } : {});
  const ext = fakeExtension({
    fetch: async (url) => url === failUrl ? new Response('', { status: 500 }) : new Response(`data of ${url}`),
  });
  const page = async (type, extra) => {
    if (type === 'status') return { hooked: true, appSocket: true, loggedIn: true, userId: '555' };
    if (type === 'diag') return { frames: [{ opcode: 49 }] };
    if (silent) throw new Error(`MAX не ответил за ${extra.timeoutMs / 1000} с (опкод ${extra.opcode})`);
    return request(extra.opcode, extra.payload);
  };
  const notified = [];
  const agent = createAgent({
    page, background: ext.background, offscreen: ext.offscreen, notify: (s) => notified.push(s), timeZone: 'Europe/Moscow',
    sleep: async () => {}, pollMs: 0, delayMs: 0, now: () => Date.UTC(2026, 9, 19, 18, 5),
  });
  return { agent, ext, notified };
}

const OPTIONS = { formats: { html: true, json: false }, kinds: ['file', 'video'], fromMs: null, toMs: null, maxBytes: null };

test('agent names the open group chat and exports it in the background as one archive', async () => {
  const { agent, ext, notified } = setup();
  assert.deepEqual(await agent.handle({ type: 'chat', chatId: '-72013802979440' }), { id: '-72013802979440', title: 'Пример чата', type: null });

  assert.deepEqual(await agent.handle({ type: 'start', chatId: '-72013802979440', title: 'Пример чата', options: OPTIONS }), { started: true });
  await assert.rejects(() => agent.handle({ type: 'start', chatId: '1', options: OPTIONS }), /уже идёт/);

  while (agent.state.running) await new Promise((r) => setImmediate(r));
  const { export: s } = await agent.handle({ type: 'status' });
  assert.equal(s.running, false);
  assert.equal(s.error, null);
  assert.equal(s.summary.downloaded, 2);
  assert.equal(s.summary.archive, 'Max-Chat-Export/Пример чата_2026-10-19_21-05.zip');
  assert.deepEqual(s.log.map((e) => [e.name, e.status]).sort(), [['Document.xlsx', 'ok'], ['video_9.mp4', 'ok']]);
  assert.equal(ext.saved.length, 1, 'a single download');
  const { filename, files } = await ext.archive();
  assert.equal(filename, s.summary.archive);
  assert.deepEqual([...files.keys()].sort(), [
    'messages.html', 'report.txt',
    'Видео/2026-10-18_19-32-00_video_9.mp4',
    'Файлы/2026-10-18_19-31-00_Document.xlsx',
  ]);
  assert.equal(files.get('Файлы/2026-10-18_19-31-00_Document.xlsx'), 'data of https://fd.oneme.ru/f/501');
  assert.match(files.get('messages.html'), /Document\.xlsx/);
  assert.ok(notified.length > 3 && notified.at(-1).running === false);
});

test('a failed attachment download is reported and the export still finishes', async () => {
  const { agent } = setup({ failUrl: 'https://cdn/1080.mp4' });
  agent.handle({ type: 'start', chatId: '-72013802979440', title: 'Пример чата', options: OPTIONS });
  while (agent.state.running) await new Promise((r) => setImmediate(r));
  assert.equal(agent.state.summary.downloaded, 1);
  assert.equal(agent.state.summary.failed, 1);
  assert.match(agent.state.log.find((e) => e.status === 'failed').error, /HTTP 500/);
});

test('diagnostics are saved under Max-Chat-Export', async () => {
  const { agent, ext } = setup();
  const r = await agent.handle({ type: 'diag' });
  assert.equal(r.saved, true);
  const [d] = ext.saved;
  assert.match(d.filename, /^Max-Chat-Export\/diagnostics_2026-10-19_21-05-00\.json$/);
  assert.match(d.text, /"opcode": 49/);
});

test('a personal dialog is named after the other person', async () => {
  const { agent } = setup({ chat: { id: 3260456, type: 'DIALOG', participants: { 3260456: 1, 555: 1 } } });
  const info = await agent.handle({ type: 'chat', chatId: '3260456' });
  assert.equal(info.title, 'Тренер');
  assert.equal(info.type, 'DIALOG');
});

test('when MAX stays silent the window gets an error quickly instead of hanging', async () => {
  const { agent } = setup({ silent: true });
  const info = await agent.handle({ type: 'chat', chatId: '-72013802979440' });
  assert.equal(info.title, null);
  assert.match(info.error, /не ответил за 6 с \(опкод 48\)/);
});

function personalDialog({ selfId = '555', peerId = '3260456', saved = true, participants = true, publicTitle = 'Мария' } = {}) {
  const chatId = String(BigInt(selfId) ^ BigInt(peerId));
  const calls = [];
  const agent = createAgent({
    page: async (type, extra) => {
      if (type === 'status') return { userId: selfId };
      calls.push(extra);
      if (extra.opcode === 48) return { chats: [{ id: chatId, type: 'DIALOG', title: publicTitle,
        ...(participants ? { participants: { [selfId]: 1, [peerId]: 1 } } : {}) }] };
      if (extra.opcode === 49) return { messages: [] }; // Current history need not contain a chat object.
      if (extra.opcode === 32) return { contacts: extra.payload.contactIds.map((id) => ({ id,
        names: String(id) === peerId ? [
          { type: 'ONEME', firstName: 'Мария', lastName: 'Петрова' },
          ...(saved ? [{ type: 'CUSTOM', name: 'Контакт' }] : []),
        ] : [{ type: 'ONEME', name: 'Чужой человек' }],
      })) };
      throw new Error(`unexpected ${extra.opcode}`);
    }, background: async () => {},
  });
  return { agent, chatId, calls };
}

test('popup shows Контакт by the peer ID and saved name, never by the dialog ID', async () => {
  const { agent, chatId, calls } = personalDialog();
  const info = await agent.handle({ type: 'chat', chatId });
  assert.equal(info.title, 'Контакт');
  assert.equal(info.type, 'DIALOG');
  const ids = calls.filter((c) => c.opcode === 32).flatMap((c) => c.payload.contactIds).map(String);
  assert.deepEqual(ids, ['3260456']);
  assert.ok(!ids.includes(chatId));
});

test('popup shows non-contacts by their public profile and handles an empty history', async () => {
  const { agent, chatId } = personalDialog({ saved: false, publicTitle: null });
  const info = await agent.handle({ type: 'chat', chatId });
  assert.equal(info.title, 'Мария Петрова');
});

test('when participants are omitted the peer is derived with BigInt XOR, not 32-bit JS XOR', async () => {
  const { agent, chatId, calls } = personalDialog({ selfId: '9000000000003', peerId: '9000000000007', participants: false });
  const info = await agent.handle({ type: 'chat', chatId });
  assert.equal(info.title, 'Контакт');
  assert.equal(String(calls.find((c) => c.opcode === 32).payload.contactIds[0]), '9000000000007');
});

test('without a captured account ID the popup never guesses a user from the dialog ID', async () => {
  let contactCalls = 0;
  const agent = createAgent({ page: async (type, extra) => {
    if (type === 'status') return { userId: null };
    if (extra.opcode === 48) return { chats: [{ id: 123, type: 'DIALOG', participants: { 42: 1, 81: 1 } }] };
    contactCalls++;
    return {};
  }, background: async () => {} });
  const result = await agent.handle({ type: 'chat', chatId: '123' });
  assert.equal(result.title, null);
  assert.match(result.error, /обновите вкладку MAX/);
  assert.equal(contactCalls, 0);
});

test('saved messages have their own title without a lookup of user ID zero', async () => {
  const { agent } = setup({ chat: { id: 0, type: 'DIALOG', participants: { 555: 1 } } });
  assert.equal((await agent.handle({ type: 'chat', chatId: '0' })).title, 'Избранное');
});

test('a finished download is noticed quickly: polling starts short and backs off to pollMs', async () => {
  const sleeps = [];
  let polls = 0;
  const agent = createAgent({
    page: async () => ({ frames: [] }),
    background: async (msg) => msg.type === 'downloadState'
      ? { state: ++polls < 6 ? 'in_progress' : 'complete' } : { id: 1 },
    sleep: async (ms) => { sleeps.push(ms); }, pollMs: 1500, now: () => Date.UTC(2026, 9, 19, 18, 5),
  });
  await agent.handle({ type: 'diag' });
  assert.deepEqual(sleeps, [200, 400, 800, 1500, 1500, 1500]);
});

test('diagnostics carry the export timeline and MAX reconnect count', async () => {
  let t = Date.UTC(2026, 9, 19, 18, 5);
  const { request } = fakeMax(makeMessages(3));
  let failed = false;
  const ext = fakeExtension();
  const saved = ext.saved;
  const agent = createAgent({
    page: async (type, extra) => {
      if (type === 'diag') return { frames: [] };
      if (extra.opcode === 49 && !failed) { failed = true; throw new Error('соединение MAX закрыто — повторите запрос'); }
      return request(extra.opcode, extra.payload);
    },
    background: ext.background, offscreen: ext.offscreen,
    sleep: async () => {}, pollMs: 0, delayMs: 0, now: () => (t += 1000),
  });
  await agent.start({ chatId: '-72013802979440', title: 'Пример чата', options: OPTIONS });
  assert.equal(agent.state.error, null);
  await agent.handle({ type: 'diag' });
  const diag = JSON.parse(saved.at(-1).text);
  assert.equal(diag.export.retries, 1);
  assert.deepEqual(diag.export.timeline.map((s) => s.stage), ['history', 'names', 'files', 'writing', 'done']);
  assert.ok(diag.export.timeline.every((s, i, all) => !i || s.t >= all[i - 1].t));
});

test('a failed export saves no archive', async () => {
  const ext = fakeExtension();
  const opened = [];
  const offscreen = async (msg) => {
    opened.push(msg.type);
    return ext.offscreen(msg);
  };
  const messages = makeMessages(1);
  messages[0].attaches = [{ _type: 'PHOTO', photoId: 1, baseUrl: 'https://i.oneme.ru/i?r=1' }];
  const { request } = fakeMax(messages);
  const agent = createAgent({
    page: async (type, extra) => {
      if (extra.opcode === 32) throw new Error('Ошибка валидации');
      return request(extra.opcode, extra.payload);
    },
    background: async (msg) => {
      opened.push(msg.type);
      return ext.background(msg);
    },
    offscreen, sleep: async () => {}, pollMs: 0, delayMs: 0,
  });
  await agent.start({ chatId: '1', title: 'Чат', options: OPTIONS });
  assert.match(agent.state.error, /Ошибка валидации/);
  assert.ok(!opened.includes('archiveSave'));
});
