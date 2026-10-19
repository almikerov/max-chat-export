// Работает в мире страницы web.max.ru с самого начала загрузки.
// Основной путь: находит WebSocket веб-версии MAX и шлёт по нему запросы
// расширения со своими номерами seq, учитывая формат конкретного соединения.
// Запасной путь (если сокет живёт не на странице): своё соединение с тем же
// входом из Local Storage. Токен не покидает браузер.
(() => {
  const P = globalThis.MceProtocol;
  const B = globalThis.MceBinary;
  const FROM_EXT = 'mce:ext';
  const FROM_PAGE = 'mce:page';
  const WS_URL = 'wss://api.oneme.ru/websocket';
  const MAX_SOCKET = /^wss:\/\/(?:[\w-]+\.)*(?:oneme|max)\.ru(?::\d+)?\/websocket(?:[?#]|$)/i;
  const TIMEOUT_MS = 20000;
  const DIAG_LIMIT = 200;
  const SECRET_KEY = /token|auth|password|phone|session|cookie|sign/i;
  const OP_INIT = 6;
  const OP_LOGIN = 19;

  const NativeWebSocket = window.WebSocket;
  const state = {
    appSocket: null, appSockets: [], ownSocket: null, ownConnecting: null,
    initPayload: null, nextSeq: 1000000000, pending: new Map(),
    socketInfo: new WeakMap(), lastUrl: WS_URL, ownReady: false,
    lastProtocol: null, userId: null, appWait: null,
    diag: [], sockets: [], textFrames: 0, binaryFrames: 0,
  };

  // ---------- диагностика: без токенов, телефонов и содержимого двоичных кадров ----------

  function redact(value, depth = 0) {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    if (depth > 6) return '<сокращено>';
    if (Array.isArray(value)) return value.slice(0, 5).map((v) => redact(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '<скрыто>' : redact(v, depth + 1)]));
  }

  function remember(direction, frame) {
    state.diag.push({ t: Date.now(), direction, cmd: frame?.cmd, seq: frame?.seq, opcode: frame?.opcode, ver: frame?.ver, payload: redact(frame?.payload) });
    if (state.diag.length > DIAG_LIMIT) state.diag.shift();
  }

  // Двоичный кадр: только размер и первые байты — по ним видно формат, но не данные.
  function rememberBinary(direction, bytes) {
    const head = Array.from(bytes.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join(' ');
    state.diag.push({ t: Date.now(), direction, binary: true, size: bytes.length, head });
    if (state.diag.length > DIAG_LIMIT) state.diag.shift();
  }

  const safeUrl = (url) => String(url).replace(/\?.*$/, '?…');

  // ---------- приём кадров ----------

  function toBytes(data) {
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function info(ws) {
    let value = state.socketInfo.get(ws);
    if (!value) {
      const binary = !/\/\/ws-api\./i.test(ws.url);
      value = { format: binary ? 'binary' : 'json', ver: binary ? 10 : 11, nextSeq: 65535, lastAppSeq: null, appPending: new Set(), loggedIn: false, entry: null };
      state.socketInfo.set(ws, value);
    }
    return value;
  }

  function learn(ws, frame, format) {
    Object.assign(info(ws), { ver: frame.ver, format });
    if (ws !== state.ownSocket && (!state.appSocket || state.appSocket === ws || state.appSocket.readyState !== NativeWebSocket.OPEN)) {
      state.appSocket = ws;
      state.lastUrl = ws.url;
      state.lastProtocol = { ver: frame.ver, format };
    }
  }

  function waiterFor(socket, frame) {
    const waiter = state.pending.get(frame.seq);
    return waiter?.socket === socket && waiter.opcode === frame.opcode &&
      (frame.cmd === P.CMD.RESPONSE || frame.cmd === P.CMD.ERROR) ? waiter : null;
  }

  function finish(seq, error, payload) {
    const waiter = state.pending.get(seq);
    if (!waiter) return;
    state.pending.delete(seq);
    clearTimeout(waiter.timer);
    error ? waiter.reject(error) : waiter.resolve(payload ?? {});
  }

  // JSON-кадр может прийти и текстом, и байтами.
  function asJsonText(bytes) {
    const first = bytes.find((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09);
    return first === 0x7b ? new TextDecoder().decode(bytes) : null;
  }

  // Ошибка MAX: русский заголовок и, в скобках, код и подробность сервера —
  // по ним видно, что именно не так в запросе.
  function maxError(p, opcode) {
    const title = p.localizedMessage || p.title || p.message || p.error || `ошибка MAX (опкод ${opcode})`;
    const detail = [p.error, p.message].filter((x) => x && x !== title).join(': ');
    return new Error(detail ? `${title} (${detail})` : title);
  }

  function handleFrame(frame, socket, event) {
    observeAccount(frame, socket);
    const waiter = waiterFor(socket, frame);
    if (waiter) {
      // The application's request table must not receive the exporter's replies.
      event?.stopImmediatePropagation?.();
      remember('ext-in', frame);
      const p = frame.payload ?? {};
      const error = frame.cmd === P.CMD.ERROR || p.error ? maxError(p, frame.opcode) : null;
      finish(frame.seq, error, p);
    } else {
      if (frame.cmd === P.CMD.RESPONSE || frame.cmd === P.CMD.ERROR) info(socket).appPending.delete(frame.seq);
      if (state.diag.length < DIAG_LIMIT) remember(socket === state.ownSocket ? 'own-in' : 'app-in', frame);
    }
  }

  function observeAccount(frame, socket) {
    if (frame.opcode !== OP_LOGIN || frame.cmd !== P.CMD.RESPONSE || frame.payload?.error) return;
    // Вход отмечаем на любом соединении приложения: при переподключении новое
    // может войти раньше, чем закроется старое.
    const meta = info(socket);
    meta.loggedIn = true;
    if (meta.entry) meta.entry.loginAt = Date.now();
    if (socket !== state.ownSocket) {
      state.appWait?.resolve();
      state.appWait = null;
    }
    if (socket !== state.appSocket && socket !== state.ownSocket) return;
    const id = frame.payload?.profile?.contact?.id;
    if (id !== null && id !== undefined && /^\d+$/.test(String(id))) state.userId = String(id);
  }

  function handleText(text, socket, event) {
    let frame;
    try {
      frame = P.parseFrame(text);
    } catch {
      return;
    }
    // Сокет API — тот, по которому ходят кадры с опкодами (на странице бывают и другие).
    if (typeof frame?.opcode !== 'number') return;
    learn(socket, frame, 'json');
    handleFrame(frame, socket, event);
  }

  function handleBytes(bytes, socket, event) {
    state.binaryFrames++;
    const text = asJsonText(bytes);
    if (text) { handleText(text, socket, event); return; }
    let frame;
    try { frame = B.header(bytes); } catch {
      if (state.diag.length < DIAG_LIMIT) rememberBinary('app-in', bytes);
      return;
    }
    learn(socket, frame, 'binary');
    if (waiterFor(socket, frame)) {
      try { handleFrame(B.parseFrame(bytes), socket, event); }
      catch (error) {
        event?.stopImmediatePropagation?.();
        rememberBinary('ext-in', bytes);
        finish(frame.seq, new Error(`не удалось разобрать ответ MAX: ${error.message}`));
      }
    } else {
      if (frame.opcode === OP_LOGIN && frame.cmd === P.CMD.RESPONSE) {
        try { observeAccount(B.parseFrame(bytes), socket); } catch { /* не мешаем входу приложения */ }
      }
      if (frame.cmd === P.CMD.RESPONSE || frame.cmd === P.CMD.ERROR) info(socket).appPending.delete(frame.seq);
      if (state.diag.length < DIAG_LIMIT) rememberBinary(socket === state.ownSocket ? 'own-in' : 'app-in', bytes);
    }
  }

  function onMessage(event) {
    const socket = event.currentTarget;
    const data = event.data;
    if (typeof data === 'string') {
      state.textFrames++;
      handleText(data, socket, event);
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then((buf) => handleBytes(new Uint8Array(buf), socket, event), () => {});
    } else {
      const bytes = toBytes(data);
      if (bytes) handleBytes(bytes, socket, event);
    }
  }

  // ---------- перехват сокетов страницы ----------

  function sniffOutgoing(data, socket) {
    if (typeof data === 'string') {
      try {
        const frame = P.parseFrame(data);
        if (typeof frame.opcode !== 'number') return;
        learn(socket, frame, 'json');
        if (frame.opcode === OP_INIT && frame.payload) state.initPayload = frame.payload;
        remember('app-out', frame);
      } catch { /* не JSON */ }
      return;
    }
    const bytes = toBytes(data);
    if (bytes) {
      try {
        const frame = B.header(bytes);
        learn(socket, frame, 'binary');
        if (frame.cmd === P.CMD.REQUEST) {
          info(socket).appPending.add(frame.seq);
          info(socket).lastAppSeq = frame.seq;
        }
        if (frame.opcode === OP_INIT) state.initPayload = B.parseFrame(bytes).payload;
      } catch { /* неизвестный формат не меняет работу приложения */ }
      if (state.diag.length < DIAG_LIMIT) rememberBinary('app-out', bytes);
    }
  }

  function attachAppSocket(ws, url, entry) {
    state.appSocket = ws;
    state.lastUrl = url;
    state.lastProtocol = null;
    info(ws).entry = entry;
    state.appSockets.push(ws);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', (event) => {
      state.appSockets = state.appSockets.filter((s) => s !== ws);
      // Код и причина закрытия — чтобы по диагностике понять, кто и почему оборвал связь.
      entry.closed = { t: Date.now(), code: event?.code ?? null, reason: String(event?.reason ?? '').slice(0, 200), wasClean: event?.wasClean ?? null };
      for (const [seq, waiter] of state.pending) {
        if (waiter.socket === ws) finish(seq, new Error('соединение MAX закрыто — повторите запрос'));
      }
    });
    const nativeSend = ws.send;
    ws.send = function (data) {
      try {
        sniffOutgoing(data, this);
      } catch { /* не мешаем приложению */ }
      return nativeSend.call(this, data);
    };
    ws.__mceSend = nativeSend;
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      try {
        const url = String(args[0]);
        const isMax = MAX_SOCKET.test(url);
        const entry = { t: Date.now(), url: safeUrl(url), protocols: args[1] ?? null, attached: isMax };
        state.sockets.push(entry);
        if (state.sockets.length > DIAG_LIMIT) state.sockets.shift();
        if (isMax) attachAppSocket(ws, url, entry);
      } catch { /* не мешаем приложению */ }
      return ws;
    },
  });

  // ---------- запросы расширения ----------

  const isOpen = (ws) => !!ws && ws.readyState === NativeWebSocket.OPEN;
  // Запросы по соединению приложения — только после его LOGIN: сразу после
  // переподключения сервер ещё не знает, чей это сокет.
  const ready = (ws) => isOpen(ws) && info(ws).loggedIn;
  const readyAppSocket = () => ready(state.appSocket) ? state.appSocket : state.appSockets.findLast(ready) ?? null;

  function appLoggedIn() {
    if (!state.appWait) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      state.appWait = { promise, resolve };
    }
    return state.appWait.promise;
  }

  function send(ws, opcode, payload, timeoutMs = TIMEOUT_MS) {
    const meta = info(ws);
    let seq;
    if (meta.format === 'binary') {
      // Keep away from the native client's next requests, including near uint16 wrap.
      if (meta.lastAppSeq !== null) {
        const distance = (meta.nextSeq - meta.lastAppSeq) & 65535;
        if (distance < 16384 || distance > 49152) meta.nextSeq = (meta.lastAppSeq + 32768) & 65535;
      }
      for (let i = 0; i < 65536; i++) {
        const candidate = meta.nextSeq;
        meta.nextSeq = (candidate - 1) & 65535;
        if (!state.pending.has(candidate) && !meta.appPending.has(candidate)) { seq = candidate; break; }
      }
      if (seq === undefined) throw new Error('все номера запросов MAX заняты');
    } else seq = state.nextSeq++;
    const data = meta.format === 'binary' ? B.buildFrame(seq, opcode, payload, meta.ver) : P.buildFrame(seq, opcode, payload, meta.ver);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(seq, new Error(`MAX не ответил за ${Math.round(timeoutMs / 1000)} с (опкод ${opcode})`));
      }, timeoutMs);
      state.pending.set(seq, { resolve, reject, timer, socket: ws, opcode });
      remember(ws === state.ownSocket ? 'own-out' : 'ext-out', { cmd: P.CMD.REQUEST, seq, opcode, ver: meta.ver, payload });
      try { (ws.__mceSend ?? ws.send).call(ws, data); }
      catch (error) { finish(seq, error); }
    });
  }

  function readStored(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') return value;
      return value?.token ?? value?.value ?? null;
    } catch {
      return raw;
    }
  }

  function userAgentPayload() {
    return {
      deviceType: 'WEB', locale: 'ru', deviceLocale: 'ru', osVersion: 'Windows',
      deviceName: 'Chrome', headerUserAgent: navigator.userAgent, appVersion: '25.11.1',
      screen: `${screen.width}x${screen.height} ${window.devicePixelRatio || 1}x`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async function openOwnSocket() {
    const token = readStored('__oneme_auth');
    const deviceId = readStored('__oneme_device_id');
    if (!token) throw new Error('не найден вход в web.max.ru — войдите в аккаунт и обновите вкладку');
    const ws = new NativeWebSocket(state.lastUrl);
    state.ownSocket = ws;
    state.ownReady = false;
    Object.assign(info(ws), state.lastProtocol ?? {});
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => {
      if (state.ownSocket === ws) state.ownReady = false;
      for (const [seq, waiter] of state.pending) {
        if (waiter.socket === ws) finish(seq, new Error('соединение MAX закрыто — повторите запрос'));
      }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('не удалось подключиться к MAX')); }, TIMEOUT_MS);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('не удалось подключиться к MAX')); }, { once: true });
        ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('соединение MAX закрыто')); }, { once: true });
      });
      await send(ws, OP_INIT, state.initPayload ?? { userAgent: userAgentPayload(), deviceId });
      await send(ws, OP_LOGIN, { interactive: false, token, chatsCount: 0, chatsSync: 0, contactsSync: 0, presenceSync: 0, draftsSync: 0 });
      state.ownReady = true;
      return ws;
    } catch (error) {
      ws.close();
      if (state.ownSocket === ws) state.ownSocket = null;
      throw error;
    }
  }

  async function socketForRequests() {
    // Соединение приложения было — ждём, пока MAX сам переподключится и войдёт.
    // Свой вход с тем же токеном параллельно с приложением может выбить его сессию.
    if (state.appSocket) {
      let ws;
      while (!(ws = readyAppSocket())) await appLoggedIn();
      return ws;
    }
    if (isOpen(state.ownSocket) && state.ownReady) return state.ownSocket;
    state.ownConnecting ??= openOwnSocket().finally(() => { state.ownConnecting = null; });
    return state.ownConnecting;
  }

  async function request(opcode, payload, timeoutMs) {
    const limit = timeoutMs || TIMEOUT_MS;
    const started = Date.now();
    let timer;
    // A popup's six-second deadline includes connecting and authentication.
    const socket = await Promise.race([
      socketForRequests(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const seconds = Math.round(limit / 1000);
          reject(new Error(state.appSocket && !readyAppSocket()
            ? `MAX переподключается дольше ${seconds} с — откройте вкладку MAX`
            : `MAX не ответил за ${seconds} с (опкод ${opcode})`));
        }, limit);
      }),
    ]).finally(() => clearTimeout(timer));
    return send(socket, opcode, payload, Math.max(1, limit - (Date.now() - started)));
  }

  function status() {
    const active = isOpen(state.appSocket) ? state.appSocket : state.ownSocket;
    const protocol = active ? info(active) : { ver: 10, format: 'binary' };
    return {
      hooked: true,
      appSocket: isOpen(state.appSocket),
      ownSocket: isOpen(state.ownSocket) && state.ownReady,
      loggedIn: !!localStorage.getItem('__oneme_auth'),
      userId: state.userId,
      ver: protocol.ver,
      transport: protocol.format,
      textFrames: state.textFrames,
      binaryFrames: state.binaryFrames,
      url: location.href,
    };
  }

  function reply(id, ok, data) {
    window.postMessage({ source: FROM_PAGE, id, ok, data }, location.origin);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.source !== FROM_EXT) return;
    if (msg.type === 'status') reply(msg.id, true, status());
    else if (msg.type === 'diag') {
      reply(msg.id, true, {
        status: status(),
        sockets: state.sockets,
        storageKeys: Object.keys(localStorage).filter((k) => /oneme|max/i.test(k)),
        frames: state.diag,
      });
    } else if (msg.type === 'request') {
      request(msg.opcode, msg.payload, msg.timeoutMs).then(
        (payload) => reply(msg.id, true, payload),
        (error) => reply(msg.id, false, error.message),
      );
    }
  });
})();
