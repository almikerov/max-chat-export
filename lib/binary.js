// MAX binary WebSocket: 10-byte BE header, MessagePack, optional raw LZ4.
// Wire layout checked against the user's capture and PyMax's TCP codec:
// https://github.com/MaxApiTeam/PyMax/tree/main/src/pymax/protocol/tcp
// Classic script, shared by the MAIN-world hook and Node tests.
(function (root) {
  const LIMIT = 32 * 1024 * 1024;
  const DEPTH = 100;
  const LONG_FIELDS = new Set(['chatId', 'chatIds', 'contactIds', 'fileId', 'videoId', 'messageId']);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const exact = (n) => n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : String(n);

  function unpack(bytes, nesting = 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    function take(n) {
      if (n < 0 || pos + n > bytes.length) throw new Error('MessagePack: обрезанные данные');
      const start = pos;
      pos += n;
      return start;
    }
    const uint = (n) => n === 1 ? view.getUint8(take(n)) : n === 2 ? view.getUint16(take(n)) : view.getUint32(take(n));
    const text = (n) => decoder.decode(bytes.subarray(take(n), pos));
    function array(n, depth) {
      if (n > bytes.length - pos) throw new Error('MessagePack: неверная длина массива');
      return Array.from({ length: n }, () => read(depth + 1));
    }
    function map(n, depth) {
      if (n > (bytes.length - pos) / 2) throw new Error('MessagePack: неверная длина объекта');
      const pairs = [];
      for (let i = 0; i < n; i++) pairs.push([String(read(depth + 1)), read(depth + 1)]);
      return Object.fromEntries(pairs);
    }
    function ext(n, depth) {
      const type = view.getInt8(take(1));
      const data = bytes.slice(take(n), pos);
      // MAX wraps numeric values (including int32/int64/uint64) in ext type 1.
      if (type === 1) return unpack(data, depth + 1);
      return { extensionType: type, data: Array.from(data) };
    }
    function read(depth = nesting) {
      if (depth > DEPTH) throw new Error('MessagePack: слишком глубокая структура');
      const b = uint(1);
      if (b <= 0x7f) return b;
      if (b >= 0xe0) return b - 256;
      if (b >= 0xa0 && b <= 0xbf) return text(b & 31);
      if (b >= 0x90 && b <= 0x9f) return array(b & 15, depth);
      if (b >= 0x80 && b <= 0x8f) return map(b & 15, depth);
      switch (b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: case 0xc5: case 0xc6: {
          const n = uint(2 ** (b - 0xc4));
          return Array.from(bytes.subarray(take(n), pos));
        }
        case 0xc7: return ext(uint(1), depth);
        case 0xc8: return ext(uint(2), depth);
        case 0xc9: return ext(uint(4), depth);
        case 0xca: return view.getFloat32(take(4));
        case 0xcb: return view.getFloat64(take(8));
        case 0xcc: return uint(1);
        case 0xcd: return uint(2);
        case 0xce: return uint(4);
        case 0xcf: return exact(view.getBigUint64(take(8)));
        case 0xd0: return view.getInt8(take(1));
        case 0xd1: return view.getInt16(take(2));
        case 0xd2: return view.getInt32(take(4));
        case 0xd3: return exact(view.getBigInt64(take(8)));
        case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: return ext(2 ** (b - 0xd4), depth);
        case 0xd9: return text(uint(1));
        case 0xda: return text(uint(2));
        case 0xdb: return text(uint(4));
        case 0xdc: return array(uint(2), depth);
        case 0xdd: return array(uint(4), depth);
        case 0xde: return map(uint(2), depth);
        case 0xdf: return map(uint(4), depth);
        default: throw new Error(`MessagePack: неизвестный маркер ${b}`);
      }
    }
    const result = read();
    if (pos !== bytes.length) throw new Error('MessagePack: лишние данные');
    return result;
  }

  function pack(value) {
    const out = [];
    function add(data) {
      if (out.length + data.length > LIMIT) throw new Error('MessagePack: пакет слишком большой');
      for (const b of data) out.push(b);
    }
    function number(marker, n, size, signed = false) {
      const bytes = new Uint8Array(size);
      const view = new DataView(bytes.buffer);
      if (size === 8) signed ? view.setBigInt64(0, n) : view.setBigUint64(0, n);
      else if (size === 1) signed ? view.setInt8(0, n) : view.setUint8(0, n);
      else if (size === 2) signed ? view.setInt16(0, n) : view.setUint16(0, n);
      else signed ? view.setInt32(0, n) : view.setUint32(0, n);
      out.push(marker);
      add(bytes);
    }
    function length(n, small, maxSmall, m8, m16, m32) {
      if (n <= maxSmall) out.push(small | n);
      else if (m8 && n <= 255) number(m8, n, 1);
      else if (n <= 65535) number(m16, n, 2);
      else number(m32, n, 4);
    }
    function integer(n, forceLong = false) {
      if (n < -(1n << 63n) || n >= (1n << 64n)) throw new Error('MessagePack: ID вне диапазона int64');
      // IDs use Long even when their value fits in int32 (as in the capture).
      if (forceLong || n > 0xffffffffn || n < -0x80000000n) {
        out.push(0xc7, 9, 1);
        number(n < 0 ? 0xd3 : 0xcf, n, 8, n < 0);
      } else if (n >= 0 && n <= 127) out.push(Number(n));
      else if (n >= -32 && n < 0) out.push(Number(n) & 255);
      else if (n >= 0 && n <= 255) number(0xcc, Number(n), 1);
      else if (n >= 0 && n <= 65535) number(0xcd, Number(n), 2);
      else if (n >= 0 && n <= 0xffffffffn) number(0xce, Number(n), 4);
      else if (n >= -128 && n < 0) number(0xd0, Number(n), 1, true);
      else if (n >= -32768 && n < 0) number(0xd1, Number(n), 2, true);
      else number(0xd2, Number(n), 4, true);
    }
    function write(v, depth = 0, field = '') {
      if (depth > DEPTH) throw new Error('MessagePack: слишком глубокая структура');
      if (v === null || v === undefined) out.push(0xc0);
      else if (typeof v === 'boolean') out.push(v ? 0xc3 : 0xc2);
      else if (typeof v === 'bigint') integer(v, LONG_FIELDS.has(field));
      else if (typeof v === 'number') {
        if (Number.isSafeInteger(v)) integer(BigInt(v), LONG_FIELDS.has(field));
        else {
          if (Number.isInteger(v)) throw new Error('MessagePack: неточный числовой ID');
          const data = new Uint8Array(8);
          new DataView(data.buffer).setFloat64(0, v);
          out.push(0xcb);
          add(data);
        }
      } else if (typeof v === 'string') {
        const data = encoder.encode(v);
        length(data.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
        add(data);
      } else if (Array.isArray(v)) {
        length(v.length, 0x90, 15, null, 0xdc, 0xdd);
        for (const item of v) write(item, depth + 1, field);
      } else if (typeof v === 'object' && Object.hasOwn(v, '__mce_raw__')) integer(BigInt(v.__mce_raw__), LONG_FIELDS.has(field));
      else if (typeof v === 'object') {
        const entries = Object.entries(v).filter(([, item]) => item !== undefined);
        length(entries.length, 0x80, 15, null, 0xde, 0xdf);
        for (const [key, item] of entries) { write(key, depth + 1); write(item, depth + 1, key); }
      } else throw new Error('MessagePack: неподдерживаемое значение');
    }
    write(value);
    return new Uint8Array(out);
  }

  function inflate(src) {
    let dst = new Uint8Array(Math.min(Math.max(src.length * 4, 64), LIMIT));
    let i = 0;
    let size = 0;
    function reserve(n) {
      if (size + n > LIMIT) throw new Error('LZ4: пакет слишком большой');
      if (size + n > dst.length) {
        const bigger = new Uint8Array(Math.min(LIMIT, Math.max(size + n, dst.length * 2)));
        bigger.set(dst);
        dst = bigger;
      }
    }
    function length(n) {
      if (n === 15) {
        let b;
        do {
          if (i >= src.length) throw new Error('LZ4: обрезанная длина');
          b = src[i++];
          n += b;
        } while (b === 255);
      }
      return n;
    }
    while (i < src.length) {
      const token = src[i++];
      const literals = length(token >> 4);
      if (i + literals > src.length) throw new Error('LZ4: обрезанные данные');
      reserve(literals);
      dst.set(src.subarray(i, i + literals), size);
      size += literals;
      i += literals;
      if (i === src.length) break;
      if (i + 2 > src.length) throw new Error('LZ4: обрезанное смещение');
      const offset = src[i++] | (src[i++] << 8);
      if (!offset || offset > size) throw new Error('LZ4: неверное смещение');
      const matches = length(token & 15) + 4;
      reserve(matches);
      for (let j = 0; j < matches; j++) { dst[size] = dst[size - offset]; size++; }
    }
    return dst.slice(0, size);
  }

  function header(bytes) {
    if (bytes.length < 10 || (bytes[0] !== 10 && bytes[0] !== 11) || bytes[1] > 3) throw new Error('неизвестный двоичный протокол MAX');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(6) & 0xffffff;
    if (bytes.length !== size + 10) throw new Error('обрезанный двоичный пакет MAX');
    return { ver: bytes[0], cmd: bytes[1], seq: view.getUint16(2), opcode: view.getUint16(4), flags: bytes[6] };
  }

  function parseFrame(bytes) {
    const frame = header(bytes);
    if (frame.flags > 127) throw new Error(`неподдерживаемое сжатие MAX (${frame.flags})`);
    let payload = bytes.subarray(10);
    if (frame.flags) payload = inflate(payload);
    return { ...frame, payload: payload.length ? unpack(payload) : {} };
  }

  function buildFrame(seq, opcode, payload, ver = 10, cmd = 0) {
    if (!Number.isInteger(seq) || seq < 0 || seq > 65535) throw new Error('seq MAX вне диапазона uint16');
    const body = pack(payload ?? {});
    if (body.length > 0xffffff) throw new Error('пакет MAX слишком большой');
    const bytes = new Uint8Array(10 + body.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = ver;
    bytes[1] = cmd;
    view.setUint16(2, seq);
    view.setUint16(4, opcode);
    view.setUint32(6, body.length); // Requests need no compression.
    bytes.set(body, 10);
    return bytes;
  }

  root.MceBinary = { header, parseFrame, buildFrame, pack, unpack, inflate };
})(globalThis);
