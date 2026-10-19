// Разбор ZIP в тестах — независимо от сборщика, по спецификации формата.
import assert from 'node:assert/strict';
import { crc32 } from '../lib/zip.js';

const decoder = new TextDecoder();

// Читает архив так же, как распаковщик: от конца к центральному каталогу и локальным заголовкам.
export function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = buf.length - 22;
  while (v.getUint32(end, true) !== 0x06054b50) end--;
  let count = v.getUint16(end + 10, true);
  let start = v.getUint32(end + 16, true);
  let zip64 = false;
  if (count === 0xffff) {
    zip64 = true;
    const record = Number(v.getBigUint64(end - 20 + 8, true));
    assert.equal(v.getUint32(record, true), 0x06064b50);
    count = Number(v.getBigUint64(record + 32, true));
    start = Number(v.getBigUint64(record + 48, true));
  }
  const files = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    assert.equal(v.getUint16(p + 8, true) & 0x0800, 0x0800, 'UTF-8 names');
    const crc = v.getUint32(p + 16, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    let offset = v.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (extraLen) {
      const e = p + 46 + nameLen;
      let field = e + 4;
      if (size === 0xffffffff) { size = Number(v.getBigUint64(field, true)); field += 16; }
      if (offset === 0xffffffff) offset = Number(v.getBigUint64(field, true));
    }
    assert.equal(v.getUint32(offset, true), 0x04034b50);
    const dataAt = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const data = buf.subarray(dataAt, dataAt + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files.push({ name, text: decoder.decode(data), size });
    p += 46 + nameLen + extraLen + v.getUint16(p + 32, true);
  }
  return { files, zip64 };
}
