import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/protocol.js';
import '../lib/binary.js';

const B = globalThis.MceBinary;
const hex = (s) => new Uint8Array(Buffer.from(s.replaceAll(' ', ''), 'hex'));

test('contact request matches the binary layout and Long wrapper in the diagnosis', () => {
  // Complete synthetic request with the captured opcode/header and contact ID.
  const bytes = hex('0a00000400200000001981aa636f6e7461637449647391c70901cf0000000006f85f0c');
  assert.deepEqual(B.parseFrame(bytes), {
    ver: 10, cmd: 0, seq: 4, opcode: 32, flags: 0, payload: { contactIds: [116940556] },
  });
  assert.deepEqual(B.buildFrame(4, 32, { contactIds: [116940556] }), bytes);
});

test('raw LZ4 reference fixture decodes for all compression factors in the capture', () => {
  // Independent PyMax regression fixture: literals, extended lengths and overlapping matches.
  const block = hex('f40a84a6707265666978a27878a464617461b0664a73436c4b437508008fa47461696cd92a79010016dfa6726570656174d9684142434404004c504441424344');
  for (const flags of [1, 2, 3, 4]) {
    const frame = new Uint8Array(10 + block.length);
    frame.set(hex('0a01000e003100000000'));
    new DataView(frame.buffer).setUint32(6, (flags << 24) | block.length);
    frame.set(block, 10);
    assert.deepEqual(B.parseFrame(frame).payload, {
      prefix: 'xx', data: 'fJsClKCufJsClKCu', tail: 'y'.repeat(42), repeat: 'ABCD'.repeat(26),
    });
  }
});

test('MessagePack handles signed/unsigned Long, maps with Long keys, floats, bytes and extensions', () => {
  assert.equal(B.unpack(hex('cf019ed3f7d5fd7fb7')), '116763701758754743');
  assert.equal(B.unpack(hex('d38000000000000000')), '-9223372036854775808');
  assert.equal(B.unpack(hex('c70901cfffffffffffffffff')), '18446744073709551615');
  assert.equal(B.unpack(hex('c70501d2ffffffff')), -1);
  assert.deepEqual(B.unpack(hex('81c70901cf0000000006f85f0c01')), { 116940556: 1 });
  assert.deepEqual(B.unpack(hex('93ca3fc00000c4020102d42a7f')), [1.5, [1, 2], { extensionType: 42, data: [127] }]);
});

test('binary encoding preserves unsafe IDs and leaves messageId strings as strings', () => {
  const payload = { chatId: -72013736853616, videoId: globalThis.MceProtocol.numberField('18446744073709551615'),
    messageId: '116762160362694583', text: 'Тренировка ⚽', from: 1792440955651, forward: 0,
    backward: 50, getChat: true, getMessages: false, optional: null, list: [-33, -129, -32769, 128, 256, 65536, 1.5] };
  const frame = B.buildFrame(65535, 83, payload);
  assert.deepEqual(Array.from(frame.slice(0, 6)), [10, 0, 255, 255, 0, 83]);
  const result = B.parseFrame(frame).payload;
  assert.equal(result.videoId, '18446744073709551615');
  assert.equal(result.chatId, payload.chatId);
  assert.equal(result.messageId, payload.messageId);
  assert.equal(result.text, payload.text);
  assert.deepEqual(result.list, payload.list);
  assert.equal(result.from, payload.from);
  assert.equal(result.getMessages, false);
});

test('empty acknowledgements decode, corrupt lengths and unsupported compression fail explicitly', () => {
  assert.deepEqual(B.parseFrame(hex('0a010008000100000000')).payload, {});
  assert.throws(() => B.parseFrame(hex('0a010008000100000005')), /обрезан/);
  assert.throws(() => B.parseFrame(hex('0a0100080001ff00000100')), /сжатие/);
  assert.throws(() => B.unpack(hex('da00056162')), /обрезан/);
  assert.throws(() => B.unpack(hex('ddffffffff')), /длина/);
  assert.throws(() => B.unpack(hex('81')), /длина/);
  assert.throws(() => B.unpack(hex('c1')), /маркер/);
  assert.throws(() => B.inflate(hex('10010000')), /смещение/);
  assert.throws(() => B.inflate(hex('f0ff')), /длина/);
  assert.throws(() => B.buildFrame(65536, 49, {}), /uint16/);
  assert.throws(() => B.pack({ id: 9007199254740992 }), /неточный/);
});
