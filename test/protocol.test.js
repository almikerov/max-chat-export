import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/protocol.js';

const P = globalThis.MceProtocol;

test('parseFrame keeps 18-digit message ids exact as strings', () => {
  const frame = P.parseFrame('{"cmd":1,"seq":5,"payload":{"messages":[{"id":116762160362694583,"time":1781704393993,"sender":9000000000003}]}}');
  const m = frame.payload.messages[0];
  assert.equal(m.id, '116762160362694583');
  assert.equal(m.time, 1781704393993);
  assert.equal(m.sender, 9000000000003);
  assert.equal(frame.seq, 5);
});

test('parseFrame leaves numbers inside strings untouched, including escapes', () => {
  const frame = P.parseFrame('{"text":"счёт: 1234567890123456789, \\"цитата\\" 99","n":-1234567890123456789,"f":1.5e3}');
  assert.equal(frame.text, 'счёт: 1234567890123456789, "цитата" 99');
  assert.equal(frame.n, '-1234567890123456789');
  assert.equal(frame.f, 1500);
});

test('buildFrame emits raw numbers for ids beyond 2^53', () => {
  const frame = P.buildFrame(7, 88, { chatId: -72013736853616, messageId: '116762160362694583', fileId: P.numberField('123456789012345678') });
  assert.equal(frame, '{"ver":11,"cmd":0,"seq":7,"opcode":88,"payload":{"chatId":-72013736853616,"messageId":"116762160362694583","fileId":123456789012345678}}');
});

test('numberField returns safe numbers as numbers', () => {
  assert.equal(P.numberField('16508201099037'), 16508201099037);
  assert.equal(P.numberField(42), 42);
  assert.deepEqual(P.numberField('116762160362694583'), P.rawNumber('116762160362694583'));
});

test('pickVideoUrl takes the best MP4 quality and falls back to dynamicUrl', () => {
  assert.equal(P.pickVideoUrl({ EXTERNAL: 'x', MP4_720: 'a', MP4_1080: 'b', MP4_360: 'c' }), 'b');
  assert.equal(P.pickVideoUrl({ dynamicUrl: 'd' }), 'd');
  assert.equal(P.pickVideoUrl({ EXTERNAL: 'https://m.ok.ru/video/1' }), null);
});
