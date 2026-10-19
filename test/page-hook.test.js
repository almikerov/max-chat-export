// page-hook.js в поддельном окружении страницы web.max.ru (vm + фальшивый WebSocket).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../lib/binary.js';
import { createAgent } from '../lib/agent-core.js';
import { fakeExtension } from './fake-extension.js';

const root = new URL('../', import.meta.url);
const protocolSrc = readFileSync(new URL('lib/protocol.js', root), 'utf8');
const binarySrc = readFileSync(new URL('lib/binary.js', root), 'utf8');
const hookSrc = readFileSync(new URL('page-hook.js', root), 'utf8');
const B = globalThis.MceBinary;

function makePage({ storage = {}, serve }) {
  const ctx = vm.createContext({ setTimeout, clearTimeout, console, Intl, TextDecoder, TextEncoder, Blob });
  // Внутри vm `window` — глобальный объект контекста, а не наш ctx; event.source должен быть им.
  const pageWindow = vm.runInContext('globalThis', ctx);
  const windowListeners = [];
  const replies = [];

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = {};
      FakeWebSocket.instances.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.emit('open', {});
      }, 0);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    send(data) {
      this.sent.push(data);
      const frame = typeof data === 'string' ? JSON.parse(data) : B.parseFrame(data);
      let answer = serve(frame, this, data);
      if (typeof data !== 'string' && typeof answer === 'string') {
        const parsed = JSON.parse(answer);
        // A binary connection answers in binary; preserve JSON's large IDs as Long.
        const payload = globalThis.MceProtocol.parseFrame(answer).payload;
        for (const m of payload.messages ?? []) if (m.id) m.id = BigInt(m.id);
        answer = B.buildFrame(parsed.seq, parsed.opcode, payload, frame.ver, parsed.cmd);
      }
      if (answer) setTimeout(() => this.emit('message', { data: answer, currentTarget: this }), 0);
    }
    emit(type, event) {
      let stopped = false;
      event.stopImmediatePropagation = () => { stopped = true; };
      for (const fn of this.listeners[type] ?? []) { fn(event); if (stopped) break; }
      if (stopped) this.stopped = (this.stopped ?? 0) + 1;
    }
    close(code = 1006, reason = '') {
      this.readyState = 3;
      this.emit('close', { currentTarget: this, code, reason, wasClean: code === 1000 });
    }
  }

  Object.assign(ctx, {
    window: ctx,
    WebSocket: FakeWebSocket,
    location: { href: 'https://web.max.ru/-72013736853616', origin: 'https://web.max.ru' },
    localStorage: { getItem: (k) => storage[k] ?? null },
    navigator: { userAgent: 'TestAgent/1.0' },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    addEventListener: (type, fn) => type === 'message' && windowListeners.push(fn),
    postMessage: (data) => setTimeout(() => {
      if (data.source === 'mce:page') replies.push(data);
      for (const fn of windowListeners) fn({ data, source: pageWindow });
    }, 0),
  });
  vm.runInContext(protocolSrc, ctx);
  vm.runInContext(binarySrc, ctx);
  vm.runInContext(hookSrc, ctx);

  const ask = (msg) => new Promise((resolve) => {
    const id = Math.random();
    ctx.postMessage({ ...msg, id, source: 'mce:ext' });
    const poll = () => {
      const r = replies.find((x) => x.id === id);
      r ? resolve(r) : setTimeout(poll, 1);
    };
    poll();
  });
  return { ctx, FakeWebSocket, ask };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// MessagePack marker of a map value by key: 0xc7 = ext (Long), 0xa0–0xbf / 0xd9 = string.
function wireMarker(bytes, key) {
  const name = new TextEncoder().encode(key);
  for (let i = 10; i < bytes.length - name.length; i++) {
    if (bytes[i] === (0xa0 | name.length) && name.every((b, j) => bytes[i + 1 + j] === b)) return bytes[i + 1 + name.length];
  }
  return null;
}

// The app's connection after its LOGIN: only then does the exporter use it.
async function loggedInApp(page, url = 'wss://api.oneme.ru/websocket') {
  const app = new page.ctx.WebSocket(url);
  await tick();
  const payload = { profile: { contact: { id: 555 } } };
  app.emit('message', { currentTarget: app, data: /\/\/ws-api\./.test(url)
    ? JSON.stringify({ ver: 11, cmd: 1, seq: 1, opcode: 19, payload })
    : binaryReply({ seq: 1, opcode: 19 }, payload) });
  return app;
}

// Сервер: отвечает cmd=1 с тем же seq; ID сообщения длиннее 2^53 — как у MAX.
const serveHistory = (frame) => {
  if (frame.opcode === 49) return `{"ver":11,"cmd":1,"seq":${frame.seq},"opcode":49,"payload":{"messages":[{"id":116762160362694583,"time":1781704393993,"text":"ok"}]}}`;
  if (frame.opcode === 88) return `{"ver":11,"cmd":3,"seq":${frame.seq},"opcode":88,"payload":{"error":"file.not.found","localizedMessage":"Файл не найден"}}`;
  if (frame.opcode === 6 || frame.opcode === 19) return `{"ver":11,"cmd":1,"seq":${frame.seq},"opcode":${frame.opcode},"payload":{}}`;
  return null;
};

test('requests ride the app socket and keep long ids exact', async () => {
  const page = makePage({ serve: serveHistory });
  const app = await loggedInApp(page, 'wss://ws-api.oneme.ru/websocket');
  app.send('{"ver":11,"cmd":0,"seq":1,"opcode":6,"payload":{"deviceId":"d"}}');
  await tick();

  const status = await page.ask({ type: 'status' });
  assert.equal(status.data.appSocket, true);

  const reply = await page.ask({ type: 'request', opcode: 49, payload: { chatId: -72013736853616, from: 1, backward: 50 } });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.messages[0].id, '116762160362694583');
  assert.equal(page.FakeWebSocket.instances.length, 1, 'no extra connection');
  const sent = JSON.parse(app.sent.at(-1));
  assert.ok(sent.seq >= 1000000000, 'own seq range');
});

test('server errors come back as readable failures', async () => {
  const page = makePage({ serve: serveHistory });
  await loggedInApp(page, 'wss://ws-api.oneme.ru/websocket');
  const reply = await page.ask({ type: 'request', opcode: 88, payload: { chatId: 1, messageId: '1', fileId: 2 } });
  assert.equal(reply.ok, false);
  assert.equal(reply.data, 'Файл не найден (file.not.found)');
});

test('without an app socket it logs in with the stored web session', async () => {
  const page = makePage({ storage: { __oneme_auth: '"secret-token"', __oneme_device_id: '"dev-1"' }, serve: serveHistory });
  const reply = await page.ask({ type: 'request', opcode: 49, payload: { chatId: 1, from: 1, backward: 1 } });
  assert.equal(reply.ok, true);
  const [own] = page.FakeWebSocket.instances;
  assert.equal(own.url, 'wss://api.oneme.ru/websocket');
  const frames = own.sent.map((s) => B.parseFrame(s));
  assert.deepEqual(frames.map((f) => f.opcode), [6, 19, 49]);
  assert.equal(frames[0].payload.deviceId, 'dev-1');
  assert.equal(frames[1].payload.token, 'secret-token');

  const diag = await page.ask({ type: 'diag' });
  assert.ok(!JSON.stringify(diag.data).includes('secret-token'), 'token is redacted in diagnostics');
});

test('without login it explains what to do', async () => {
  const page = makePage({ serve: serveHistory });
  const reply = await page.ask({ type: 'request', opcode: 49, payload: {} });
  assert.equal(reply.ok, false);
  assert.match(reply.data, /войдите в аккаунт/);
});

test('JSON frames that arrive as bytes are understood, and sockets are listed', async () => {
  const page = makePage({ serve: () => null });
  const other = new page.ctx.WebSocket('wss://calls.example.com/signal');
  const app = await loggedInApp(page, 'wss://ws-api.oneme.ru/websocket?token=secret');
  const pending = page.ask({ type: 'request', opcode: 49, payload: { chatId: 1 } });
  await tick();
  const sent = JSON.parse(app.sent.at(-1));
  const bytes = new TextEncoder().encode(`{"ver":11,"cmd":1,"seq":${sent.seq},"opcode":49,"payload":{"messages":[{"id":116762160362694583}]}}`);
  app.emit('message', { data: bytes.buffer, currentTarget: app });
  const reply = await pending;
  assert.equal(reply.ok, true);
  assert.equal(reply.data.messages[0].id, '116762160362694583');
  assert.equal(other.sent.length, 0, 'foreign sockets are never used');

  app.emit('message', { data: new Uint8Array([0x85, 0xa3, 0x76, 0x65, 0x72, 0x0b]).buffer, currentTarget: app });
  const diag = await page.ask({ type: 'diag' });
  assert.deepEqual(JSON.parse(JSON.stringify(diag.data.sockets.map((s) => [s.url, s.attached]))), [
    ['wss://calls.example.com/signal', false],
    ['wss://ws-api.oneme.ru/websocket?…', true],
  ]);
  const binary = diag.data.frames.find((f) => f.binary);
  assert.equal(binary.head, '85 a3 76 65 72 0b');
  assert.equal(diag.data.status.binaryFrames, 2);
});

// Synthetic binary replies with a raw LZ4 literal block. The independent fixture
// in binary.test.js additionally exercises real compressed back references.
function binaryReply(frame, payload, { cmd = 1, flags = 2, blob = false } = {}) {
  const plain = B.buildFrame(frame.seq, frame.opcode, payload, 10, cmd);
  if (!flags) return plain;
  const body = plain.subarray(10);
  const prefix = [Math.min(body.length, 15) << 4];
  if (body.length >= 15) {
    let extra = body.length - 15;
    while (extra >= 255) { prefix.push(255); extra -= 255; }
    prefix.push(extra);
  }
  const bytes = new Uint8Array(10 + prefix.length + body.length);
  bytes.set(plain.subarray(0, 10));
  new DataView(bytes.buffer).setUint32(6, (flags << 24) | (bytes.length - 10));
  bytes.set(prefix, 10);
  bytes.set(body, 10 + prefix.length);
  return blob ? new Blob([bytes]) : bytes;
}

test('current MAX socket uses binary v10, exact Long IDs and compressed replies', async () => {
  const page = makePage({ serve: (frame) => frame.opcode === 49 ? binaryReply(frame, {
    chat: { title: 'Пример чата' }, messages: [{ id: 116762160362694583n, time: 1792440955651 }],
  }) : null });
  const app = await loggedInApp(page);
  const nativeInit = B.buildFrame(0, 6, { deviceId: 'dev-current' });
  app.send(nativeInit);
  const reply = await page.ask({ type: 'request', opcode: 49, payload: { chatId: -72013736853616, from: 1, backward: 50 } });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.messages[0].id, '116762160362694583');
  assert.equal(reply.data.chat.title, 'Пример чата');
  assert.equal(page.FakeWebSocket.instances.length, 1);
  assert.equal(app.sent[0], nativeInit, 'native data is passed unchanged');
  const sent = B.parseFrame(app.sent.at(-1));
  assert.equal(sent.seq, 32768);
  assert.equal(sent.ver, 10);
  assert.equal(sent.payload.chatId, -72013736853616);
  const status = await page.ask({ type: 'status' });
  assert.equal(status.data.transport, 'binary');
  assert.equal(status.data.ver, 10);
  assert.equal(app.stopped, 1, 'exporter response does not reach native request handlers');
});

test('binary requests skip native in-flight seq and match socket, opcode and command', async () => {
  const page = makePage({ serve: () => null });
  const stale = new page.ctx.WebSocket('wss://api.oneme.ru/websocket');
  const app = await loggedInApp(page);
  app.send(B.buildFrame(32768, 49, {}));
  app.send(B.buildFrame(0, 1, {}));
  const pending = page.ask({ type: 'request', opcode: 49, payload: {}, timeoutMs: 1000 });
  await tick();
  const sent = B.parseFrame(app.sent.at(-1));
  assert.equal(sent.seq, 32767);
  stale.emit('message', { currentTarget: stale, data: binaryReply(sent, { wrong: 'socket' }) });
  app.emit('message', { currentTarget: app, data: binaryReply({ ...sent, opcode: 32 }, { wrong: 'opcode' }) });
  app.emit('message', { currentTarget: app, data: binaryReply(sent, { wrong: 'notification' }, { cmd: 0 }) });
  app.emit('message', { currentTarget: app, data: binaryReply(sent, { messages: [] }) });
  const reply = await pending;
  assert.equal(reply.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.data)), { messages: [] });
});

test('compressed Blob responses work; MAX errors under cmd=1 are failures', async () => {
  const page = makePage({ serve: (frame) => binaryReply(frame,
    frame.opcode === 88 ? { error: 'file.not.found', localizedMessage: 'Файл не найден' } : { messages: [] }, { blob: true }) });
  await loggedInApp(page);
  assert.equal((await page.ask({ type: 'request', opcode: 49, payload: {} })).ok, true);
  const error = await page.ask({ type: 'request', opcode: 88, payload: {} });
  assert.equal(error.ok, false);
  assert.equal(error.data, 'Файл не найден (file.not.found)');
});

test('unsupported binary compression gives an explicit failure instead of a timeout', async () => {
  const page = makePage({ serve: (frame) => {
    const bytes = B.buildFrame(frame.seq, frame.opcode, { messages: [] }, 10, 1);
    bytes[6] = 255;
    return bytes;
  } });
  await loggedInApp(page);
  const reply = await page.ask({ type: 'request', opcode: 49, payload: {}, timeoutMs: 1000 });
  assert.equal(reply.ok, false);
  assert.match(reply.data, /неподдерживаемое сжатие/);
});

test('socket close and synchronous send failure reject promptly; reconnect is usable', async () => {
  const page = makePage({ serve: () => null });
  const app = await loggedInApp(page);
  const pending = page.ask({ type: 'request', opcode: 49, payload: {}, timeoutMs: 1000 });
  await tick();
  app.close();
  assert.match((await pending).data, /соединение MAX закрыто/);
  const next = await loggedInApp(page);
  next.__mceSend = () => { throw new Error('socket send failed'); };
  assert.equal((await page.ask({ type: 'request', opcode: 49, payload: {} })).data, 'socket send failed');
});

test('failed binary login is closed and a later attempt authenticates again', async () => {
  let attempts = 0;
  const page = makePage({ storage: { __oneme_auth: '"private-token"', __oneme_device_id: '"dev"' }, serve: (frame) => {
    if (frame.opcode === 19 && attempts++ === 0) return binaryReply(frame, { error: 'LOGIN_FAILED' }, { cmd: 3 });
    return binaryReply(frame, frame.opcode === 49 ? { messages: [] } : {});
  } });
  const first = await page.ask({ type: 'request', opcode: 49, payload: {} });
  assert.equal(first.ok, false);
  assert.match(first.data, /LOGIN_FAILED/);
  assert.equal(page.FakeWebSocket.instances[0].readyState, 3);
  const second = await page.ask({ type: 'request', opcode: 49, payload: {} });
  assert.equal(second.ok, true);
  assert.equal(page.FakeWebSocket.instances.length, 2);
  const diag = await page.ask({ type: 'diag' });
  assert.ok(!JSON.stringify(diag).includes('private-token'));
});

test('short popup deadline includes waiting for fallback authentication', async () => {
  const page = makePage({ storage: { __oneme_auth: '"private-token"' }, serve: () => null });
  const reply = await page.ask({ type: 'request', opcode: 49, payload: {}, timeoutMs: 30 });
  assert.equal(reply.ok, false);
  assert.match(reply.data, /MAX не ответил.*опкод 49/);
  // Cancel the background connection attempt so its pending INIT does not linger.
  page.FakeWebSocket.instances[0].close();
  await tick();
});

test('full diagnostics buffer does not stop binary replies, and deeply nested secrets are omitted', async () => {
  const page = makePage({ serve: (frame) => frame.opcode === 49 ? binaryReply(frame, { messages: [] }) : null });
  const app = await loggedInApp(page);
  for (let i = 0; i < 210; i++) app.emit('message', { currentTarget: app, data: B.buildFrame(i, 1, {}, 10, 1) });
  assert.equal((await page.ask({ type: 'request', opcode: 49, payload: {} })).ok, true);
  app.send(JSON.stringify({ ver: 11, cmd: 0, seq: 1, opcode: 6,
    payload: { a: { b: { c: { d: { e: { f: { g: { token: 'deep-secret' } } } } } } } } }));
  const diag = await page.ask({ type: 'diag' });
  assert.equal(diag.data.frames.length, 200);
  assert.ok(!JSON.stringify(diag).includes('deep-secret'));
});

test('full agent export runs history, contact lookup and attachment URLs over binary MAX', async () => {
  const time = 1792440955651;
  const messages = [{ id: 116762160362694583n, time, sender: 116940556,
    text: 'Тренировка', attaches: [{ _type: 'FILE', fileId: 1844674407370955161n, name: 'Document.xlsx', size: 1234 },
      { _type: 'VIDEO', videoId: 116762160362694590n, token: 'private-video-token' }] }];
  const page = makePage({ serve: (frame, _socket, raw) => {
    // Like the current binary MAX: file and video requests need messageId as a number.
    if ((frame.opcode === 88 || frame.opcode === 83) && wireMarker(raw, 'messageId') !== 0xc7) {
      return binaryReply(frame, { error: 'proto.payload', message: 'Expected number at 31', localizedMessage: 'Ошибка валидации' }, { cmd: 3 });
    }
    switch (frame.opcode) {
      case 48: return binaryReply(frame, { chats: [{ id: -72013736853616, type: 'CHAT', title: 'Пример чата' }] });
      case 49: return binaryReply(frame, { chat: { title: 'Пример чата' }, messages: frame.payload.from > time ? messages : [] });
      case 32: return binaryReply(frame, { contacts: [{ id: 116940556, names: [{ type: 'FULL_NAME', name: 'Тренер' }] }] });
      case 88: return binaryReply(frame, { url: 'https://cdn.example/report.xlsx' });
      case 83: return binaryReply(frame, { MP4_720: 'https://cdn.example/training.mp4' });
      default: throw new Error(`unexpected opcode ${frame.opcode}`);
    }
  } });
  const app = await loggedInApp(page);
  const fetched = [];
  const ext = fakeExtension({ fetch: async (url) => { fetched.push(url); return new Response(`data of ${url}`); } });
  const agent = createAgent({
    page: async (type, extra) => {
      const r = await page.ask({ type, ...extra });
      if (!r.ok) throw new Error(r.data);
      return r.data;
    },
    background: ext.background, offscreen: ext.offscreen,
    sleep: async () => {}, delayMs: 0, now: () => time + 1000, timeZone: 'Europe/Moscow',
  });
  const chat = await agent.handle({ type: 'chat', chatId: '-72013736853616' });
  assert.equal(chat.title, 'Пример чата');
  await agent.start({ chatId: chat.id, title: chat.title,
    options: { formats: { html: true, json: true }, kinds: ['file', 'video'] } });
  assert.equal(agent.state.error, null);
  assert.equal(agent.state.summary.messages, 1);
  assert.equal(agent.state.summary.downloaded, 2);
  assert.deepEqual(fetched.sort(), ['https://cdn.example/report.xlsx', 'https://cdn.example/training.mp4']);
  const { files } = await ext.archive();
  const json = files.get('messages.json');
  assert.match(json, /116762160362694583/);
  assert.match(json, /Тренер/);
  assert.ok(files.has('messages.html'));
  assert.ok(files.has('report.txt'));
  const video = [...files.keys()].find((name) => name.startsWith('Видео/'));
  assert.match(video, /_video_116762160362694590\.mp4$/);
  assert.equal(files.get(video), 'data of https://cdn.example/training.mp4');
  assert.ok([...files.keys()].some((name) => /^Файлы\/.*_Document\.xlsx$/.test(name)));
  const videoRequest = app.sent.map(B.parseFrame).find((f) => f.opcode === 83);
  assert.equal(videoRequest.payload.videoId, '116762160362694590');
  assert.equal(videoRequest.payload.messageId, '116762160362694583');
});

test('popup resolves a personal dialog from captured binary LOGIN and real profile name shapes', async () => {
  const selfId = 9000000000003;
  const peerId = 116940556;
  const chatId = String(BigInt(selfId) ^ BigInt(peerId));
  for (const saved of [true, false]) {
    const page = makePage({ serve: (frame) => {
      if (frame.opcode === 48) return binaryReply(frame, { chats: [{ id: Number(chatId), type: 'DIALOG', title: 'Мария',
        participants: { [selfId]: 1, [peerId]: 1 } }] });
      if (frame.opcode === 32) {
        assert.ok(!frame.payload.contactIds.map(String).includes(chatId), 'the dialog ID is never looked up as a person');
        return binaryReply(frame, { contacts: [{ id: peerId, names: [
          { type: 'ONEME', firstName: 'Мария', lastName: 'Петрова' },
          ...(saved ? [{ type: 'CUSTOM', name: 'Контакт' }] : []),
        ] }] });
      }
      throw new Error(`unexpected opcode ${frame.opcode}`);
    } });
    const app = new page.ctx.WebSocket('wss://api.oneme.ru/websocket');
    await tick();
    // An app LOGIN reply, not a reply to an extension request.
    app.emit('message', { currentTarget: app, data: binaryReply({ seq: 1, opcode: 19 }, {
      profile: { contact: { id: selfId, phone: 'private-phone' } }, token: 'private-token',
    }, { blob: true }) });
    await tick();
    const status = await page.ask({ type: 'status' });
    assert.equal(status.data.userId, String(selfId));
    const agent = createAgent({ page: async (type, extra) => {
      const r = await page.ask({ type, ...extra });
      if (!r.ok) throw new Error(r.data);
      return r.data;
    }, background: async () => {} });
    const info = await agent.handle({ type: 'chat', chatId });
    assert.equal(info.title, saved ? 'Контакт' : 'Мария Петрова');
    assert.equal(info.error, undefined);
    const diag = await page.ask({ type: 'diag' });
    assert.ok(!JSON.stringify(diag).includes('private-phone'));
    assert.ok(!JSON.stringify(diag).includes('private-token'));
  }
});

test('when MAX reconnects mid-export the exporter waits for the app to log in again, without a second session', async () => {
  const time = 1792440955651;
  const messages = [116762160362694583n, 116762160362694584n].map((id, i) => ({ id, time: time - i * 1000, sender: 555, text: `m${i}`, attaches: [] }));
  let dropped = false;
  const page = makePage({ storage: { __oneme_auth: '"private-token"', __oneme_device_id: '"dev"' }, serve: (frame, socket) => {
    if (frame.cmd !== 0 || frame.opcode === 19) return null; // the app's LOGIN is answered below
    if (frame.opcode === 6) return binaryReply(frame, {});
    if (frame.opcode === 49 && !dropped) {
      dropped = true;
      setTimeout(() => socket.close(1006), 0);
      return null;
    }
    if (frame.opcode === 49) return binaryReply(frame, { messages: messages.filter((m) => m.time <= frame.payload.from) });
    if (frame.opcode === 32) return binaryReply(frame, { contacts: [{ id: 555, names: [{ type: 'CUSTOM', name: 'Мария' }] }] });
    throw new Error(`unexpected opcode ${frame.opcode}`);
  } });
  const login = (app, seq) => app.emit('message', { currentTarget: app, data: binaryReply({ seq, opcode: 19 }, { profile: { contact: { id: 777 } } }) });
  const first = new page.ctx.WebSocket('wss://api.oneme.ru/websocket');
  await tick();
  login(first, 1);

  const fetched = [];
  const ext = fakeExtension({ fetch: async (url) => { fetched.push(url); return new Response(`data of ${url}`); } });
  const agent = createAgent({
    page: async (type, extra) => {
      const r = await page.ask({ type, ...extra });
      if (!r.ok) throw new Error(r.data);
      return r.data;
    },
    background: ext.background, offscreen: ext.offscreen,
    sleep: async () => {}, delayMs: 0, now: () => time + 1000, timeZone: 'Europe/Moscow',
  });
  const done = agent.start({ chatId: '116940556', title: 'Мария', options: { formats: { json: true }, kinds: [] } });
  while (first.readyState !== 3) await tick();
  await tick();

  // The app reconnects: until its LOGIN succeeds the new socket carries only the app's own frames.
  const second = new page.ctx.WebSocket('wss://api.oneme.ru/websocket');
  await tick();
  second.send(B.buildFrame(1, 6, { deviceId: 'dev' }));
  await tick();
  await tick();
  assert.deepEqual(second.sent.map((d) => B.parseFrame(d).opcode), [6], 'nothing is sent before the app logs in');
  login(second, 2);
  await done;

  assert.equal(agent.state.error, null);
  assert.equal(agent.state.summary.messages, 2);
  assert.equal(page.FakeWebSocket.instances.length, 2, 'no parallel session with the stored token');
  assert.ok(second.sent.map((d) => B.parseFrame(d).opcode).includes(49));
  const diag = await page.ask({ type: 'diag' });
  assert.equal(diag.data.sockets[0].closed.code, 1006);
});

test('an app connection that has not logged in yet is never used and the wait is explained', async () => {
  const page = makePage({ storage: { __oneme_auth: '"private-token"' }, serve: () => { throw new Error('nothing may be sent'); } });
  const app = new page.ctx.WebSocket('wss://api.oneme.ru/websocket');
  await tick();
  const reply = await page.ask({ type: 'request', opcode: 49, payload: {}, timeoutMs: 50 });
  assert.equal(reply.ok, false);
  assert.match(reply.data, /MAX переподключается дольше/);
  assert.equal(app.sent.length, 0);
  assert.equal(page.FakeWebSocket.instances.length, 1);
});

test('if the app logs in on a new connection before closing the old one, requests move to the new one', async () => {
  const page = makePage({ serve: (frame) => frame.opcode === 49 ? binaryReply(frame, { messages: [] }) : null });
  const old = await loggedInApp(page);
  const fresh = new page.ctx.WebSocket('wss://api.oneme.ru/websocket');
  // While the new connection is still connecting, a late frame makes the old one current again.
  old.emit('message', { currentTarget: old, data: B.buildFrame(9, 1, {}, 10, 1) });
  await tick();
  fresh.emit('message', { currentTarget: fresh, data: binaryReply({ seq: 1, opcode: 19 }, { profile: { contact: { id: 555 } } }) });
  old.close(1000);
  const reply = await page.ask({ type: 'request', opcode: 49, payload: {}, timeoutMs: 1000 });
  assert.equal(reply.ok, true);
  assert.ok(fresh.sent.some((d) => B.parseFrame(d).opcode === 49));
});

test('a MAX protocol error carries the server detail, not only the localized title', async () => {
  const page = makePage({ serve: (frame) => binaryReply(frame,
    { error: 'proto.payload', message: 'Expected number at 31', localizedMessage: 'Ошибка валидации', title: 'Ошибка валидации' }, { cmd: 3 }) });
  await loggedInApp(page);
  const reply = await page.ask({ type: 'request', opcode: 88, payload: {} });
  assert.equal(reply.data, 'Ошибка валидации (proto.payload: Expected number at 31)');
});
