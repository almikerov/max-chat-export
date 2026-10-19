// Общие опкоды и прежний JSON-транспорт MAX (ver 11).
// Актуальный двоичный транспорт (ver 10) — в binary.js.
// Классический скрипт без import/export: его подключает и страница MAX
// (content script в MAIN world), и ES-модули расширения/тестов — через globalThis.
(function (root) {
  const OPCODES = { CONTACTS: 32, CHAT_INFO: 48, HISTORY: 49, VIDEO_URL: 83, FILE_URL: 88 };
  const CMD = { REQUEST: 0, RESPONSE: 1, ERROR: 3 };
  const RAW_PREFIX = '__mce_raw__';

  // ID сообщений MAX длиннее 2^53 и теряют точность в JSON.parse.
  // Числа из 16+ цифр вне строк превращаем в строки до разбора.
  function parseFrame(text) {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
      const c = text[i];
      if (inString) {
        if (c === '\\') {
          out += c + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '"') inString = false;
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        inString = true;
        out += c;
        i++;
        continue;
      }
      if (c === '-' || (c >= '0' && c <= '9')) {
        let j = i + 1;
        while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
        const num = text.slice(i, j);
        out += /^-?\d{16,}$/.test(num) ? `"${num}"` : num;
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return JSON.parse(out);
  }

  // Значение, которое уйдёт на сервер числом без потери точности.
  // Простой объект, а не класс: переживает postMessage между мирами.
  function rawNumber(digits) {
    return { [RAW_PREFIX]: String(digits) };
  }

  // Строка из цифр → число, если оно точное, иначе rawNumber.
  function numberField(value) {
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : rawNumber(value);
    }
    return value;
  }

  function stringifyPayload(value) {
    const json = JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && RAW_PREFIX in v ? `${RAW_PREFIX}${v[RAW_PREFIX]}` : v);
    return json.replace(new RegExp(`"${RAW_PREFIX}(-?\\d+)"`, 'g'), '$1');
  }

  function buildFrame(seq, opcode, payload, ver = 11) {
    return `{"ver":${ver},"cmd":${CMD.REQUEST},"seq":${seq},"opcode":${opcode},"payload":${stringifyPayload(payload ?? {})}}`;
  }

  // Ответ GET_VIDEO_URL: ключи MP4_<качество>; берём лучшее.
  function pickVideoUrl(payload) {
    let best = null;
    for (const [key, url] of Object.entries(payload ?? {})) {
      const m = /^MP4_(\d+)$/i.exec(key);
      if (m && typeof url === 'string' && url && (!best || Number(m[1]) > best.quality)) {
        best = { quality: Number(m[1]), url };
      }
    }
    if (best) return best.url;
    const legacy = payload?.dynamicUrl ?? payload?.dynamic_url;
    return typeof legacy === 'string' && legacy ? legacy : null;
  }

  root.MceProtocol = { OPCODES, CMD, parseFrame, rawNumber, numberField, stringifyPayload, buildFrame, pickVideoUrl };
})(globalThis);
