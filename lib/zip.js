// ZIP без сжатия (store): фото и видео уже сжаты, а архив собирается склейкой Blob,
// поэтому данные не копируются в память. ZIP64 включается сам, когда архив больше 4 ГБ.
// Формат: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_NAMES = 0x0800;
const encoder = new TextEncoder();

let table = null;

export function crc32(bytes, crc = 0) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = (crc ^ MAX32) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

// Дата и время в формате MS-DOS — по местному времени, как показывает проводник.
function dos(ms) {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function bytes(size, fill) {
  const out = new Uint8Array(size);
  fill(new DataView(out.buffer));
  return out;
}

export class ZipWriter {
  // zip64: true — всегда ZIP64 (для тестов больших архивов на маленьких данных).
  constructor({ zip64 = false } = {}) {
    this.force64 = zip64;
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  // parts — Blob или Uint8Array с содержимым файла; size и crc посчитаны заранее.
  add(name, { parts, size, crc, time = Date.now() }) {
    const nameBytes = encoder.encode(name);
    const big = this.force64 || size >= MAX32;
    const extra = big ? bytes(20, (v) => {
      v.setUint16(0, 1, true);
      v.setUint16(2, 16, true);
      v.setBigUint64(4, BigInt(size), true);
      v.setBigUint64(12, BigInt(size), true);
    }) : new Uint8Array(0);
    const stamp = dos(time);
    const header = bytes(30, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, big ? 45 : 20, true);
      v.setUint16(6, UTF8_NAMES, true);
      v.setUint16(8, 0, true);
      v.setUint16(10, stamp.time, true);
      v.setUint16(12, stamp.date, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, big ? MAX32 : size, true);
      v.setUint32(22, big ? MAX32 : size, true);
      v.setUint16(26, nameBytes.length, true);
      v.setUint16(28, extra.length, true);
    });
    this.entries.push({ nameBytes, size, crc, stamp, offset: this.offset });
    this.parts.push(header, nameBytes, extra, ...parts);
    this.offset += header.length + nameBytes.length + extra.length + size;
  }

  blob() {
    const central = [];
    let centralSize = 0;
    for (const e of this.entries) {
      const bigSize = this.force64 || e.size >= MAX32;
      const bigOffset = this.force64 || e.offset >= MAX32;
      const fields = [...(bigSize ? [e.size, e.size] : []), ...(bigOffset ? [e.offset] : [])];
      const extra = fields.length ? bytes(4 + 8 * fields.length, (v) => {
        v.setUint16(0, 1, true);
        v.setUint16(2, 8 * fields.length, true);
        fields.forEach((f, i) => v.setBigUint64(4 + 8 * i, BigInt(f), true));
      }) : new Uint8Array(0);
      const header = bytes(46, (v) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 45, true);
        v.setUint16(6, fields.length ? 45 : 20, true);
        v.setUint16(8, UTF8_NAMES, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, e.stamp.time, true);
        v.setUint16(14, e.stamp.date, true);
        v.setUint32(16, e.crc, true);
        v.setUint32(20, bigSize ? MAX32 : e.size, true);
        v.setUint32(24, bigSize ? MAX32 : e.size, true);
        v.setUint16(28, e.nameBytes.length, true);
        v.setUint16(30, extra.length, true);
        v.setUint32(42, bigOffset ? MAX32 : e.offset, true);
      });
      central.push(header, e.nameBytes, extra);
      centralSize += header.length + e.nameBytes.length + extra.length;
    }
    const count = this.entries.length;
    const start = this.offset;
    const big = this.force64 || count >= MAX16 || start >= MAX32 || centralSize >= MAX32;
    const tail = [];
    if (big) {
      tail.push(bytes(56, (v) => {
        v.setUint32(0, 0x06064b50, true);
        v.setBigUint64(4, 44n, true);
        v.setUint16(12, 45, true);
        v.setUint16(14, 45, true);
        v.setBigUint64(24, BigInt(count), true);
        v.setBigUint64(32, BigInt(count), true);
        v.setBigUint64(40, BigInt(centralSize), true);
        v.setBigUint64(48, BigInt(start), true);
      }), bytes(20, (v) => {
        v.setUint32(0, 0x07064b50, true);
        v.setBigUint64(8, BigInt(start + centralSize), true);
        v.setUint32(16, 1, true);
      }));
    }
    tail.push(bytes(22, (v) => {
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(8, big ? MAX16 : count, true);
      v.setUint16(10, big ? MAX16 : count, true);
      v.setUint32(12, big ? MAX32 : centralSize, true);
      v.setUint32(16, big ? MAX32 : start, true);
    }));
    return new Blob([...this.parts, ...central, ...tail], { type: 'application/zip' });
  }
}

// Текстовый файл целиком в памяти: история, отчёт.
export function addText(zip, name, text, time) {
  const data = encoder.encode(text);
  zip.add(name, { parts: [data], size: data.length, crc: crc32(data), time });
}
