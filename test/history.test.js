import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHistory, fetchNames } from '../lib/history.js';
import { fakeMax, makeMessages, T0 } from './fake-max.js';

test('fetchHistory pages backward through the whole chat without duplicates', async () => {
  const messages = makeMessages(137);
  const { request, calls } = fakeMax(messages);
  const { chat, messages: got } = await fetchHistory(request, -72013736853616, { toMs: T0 + 10 ** 9, pageSize: 50 });
  assert.equal(chat.title, 'Пример чата');
  assert.equal(got.length, 137);
  assert.deepEqual(got.map((m) => m.text), messages.map((m) => m.text));
  assert.equal(new Set(got.map((m) => m.id)).size, 137);
  assert.ok(calls.length >= 3 && calls.length <= 5, `pages: ${calls.length}`);
  assert.equal(calls[0].payload.getChat, true);
  assert.equal(calls[1].payload.getChat, false);
});

test('fetchHistory respects the period and stops once past its start', async () => {
  const messages = makeMessages(300);
  const { request, calls } = fakeMax(messages);
  const fromMs = messages[250].time;
  const toMs = messages[279].time;
  const { messages: got } = await fetchHistory(request, 1, { fromMs, toMs, pageSize: 20 });
  assert.deepEqual(got.map((m) => m.text), messages.slice(250, 280).map((m) => m.text));
  assert.ok(calls.length <= 3, `should not page through the whole chat, pages: ${calls.length}`);
});

test('fetchHistory handles an empty chat', async () => {
  const { request } = fakeMax([]);
  const { messages } = await fetchHistory(request, 1, { toMs: T0 });
  assert.deepEqual(messages, []);
});

test('fetchNames resolves full names and keeps no phones', async () => {
  const { request, calls } = fakeMax([]);
  const names = await fetchNames(request, [3260456, 9000000000003, 3260456, null], { chunk: 1 });
  assert.equal(names.get('3260456'), 'Тренер');
  assert.equal(names.get('9000000000003'), 'Видеоаналитик');
  assert.equal(calls.length, 2);
  assert.ok(![...names.values()].some((v) => String(v).includes('+7')));
});

test('saved CUSTOM name wins over the public profile name regardless of array order', async () => {
  const names = await fetchNames(async () => ({ contacts: [{ id: 42, names: [
    { type: 'ONEME', name: 'Мария' }, { type: 'CUSTOM', name: 'Контакт' },
    { type: 'FULL_NAME', name: 'Мария Петрова' },
  ] }] }), [42]);
  assert.equal(names.get('42'), 'Контакт');
});

test('a person outside contacts has a public first and last name without CUSTOM', async () => {
  const names = await fetchNames(async () => ({ contacts: [
    { id: 42, names: [{ type: 'ONEME', firstName: 'Мария', lastName: 'Петрова' }] },
    { id: 43, names: [{ type: 'ONEME', name: 'Иван', firstName: 'Иван', lastName: 'Сидоров' }] },
  ] }), [42, 43]);
  assert.equal(names.get('42'), 'Мария Петрова');
  assert.equal(names.get('43'), 'Иван Сидоров');
});

test('blank CUSTOM names do not hide profiles, and split legacy names are joined', async () => {
  const names = await fetchNames(async () => ({ contacts: [
    { id: 42, names: [{ type: 'CUSTOM', name: '  ' }, { type: 'ONEME', name: 'Публичное имя' }] },
    { id: 43, names: [{ type: 'LAST_NAME', name: 'Сидоров' }, { type: 'FIRST_NAME', name: 'Иван' }] },
  ] }), [42, 43]);
  assert.equal(names.get('42'), 'Публичное имя');
  assert.equal(names.get('43'), 'Иван Сидоров');
});

test('fetchHistory asks for 1000 messages per page and reports its speed', async () => {
  const { request, calls } = fakeMax(makeMessages(2450));
  const { messages, stats } = await fetchHistory(request, 1, { toMs: T0 + 10 ** 9 });
  assert.equal(messages.length, 2450);
  assert.ok(calls.every((c) => c.payload.backward === 1000));
  assert.equal(stats.pages, calls.length);
  assert.equal(stats.pageSize, 1000);
  assert.equal(stats.largestPage, 1000);
  assert.equal(stats.messages, 2450);
  assert.ok(stats.ms >= 0);
});

test('if MAX rejects large pages, fetchHistory steps down to 200, then 50, and keeps going', async () => {
  for (const [limit, size] of [[200, 200], [50, 50]]) {
    const { request, calls } = fakeMax(makeMessages(437));
    const tried = [];
    const strict = (opcode, payload) => {
      tried.push(payload.backward);
      if (payload.backward > limit) return Promise.reject(new Error('Ошибка валидации'));
      return request(opcode, payload);
    };
    const { messages, stats } = await fetchHistory(strict, 1, { toMs: T0 + 10 ** 9 });
    assert.equal(messages.length, 437);
    assert.deepEqual(tried.slice(0, size === 200 ? 2 : 3), size === 200 ? [1000, 200] : [1000, 200, 50]);
    assert.ok(calls.every((c) => c.payload.backward === size));
    assert.equal(stats.pageSize, size);
  }
});

test('a history error with small pages is reported, not hidden', async () => {
  let calls = 0;
  const broken = async () => { calls++; throw new Error('Ошибка валидации'); };
  await assert.rejects(fetchHistory(broken, 1, { toMs: T0 }), /Ошибка валидации/);
  assert.equal(calls, 3, '1000, 200, then 50');
});

test('once a large page worked, a later error is not retried with small pages', async () => {
  const { request } = fakeMax(makeMessages(450));
  let calls = 0;
  const later = async (opcode, payload) => {
    if (calls++ === 0) return request(opcode, payload);
    throw new Error('соединение MAX закрыто — повторите запрос');
  };
  await assert.rejects(fetchHistory(later, 1, { toMs: T0 + 10 ** 9 }), /закрыто/);
  assert.equal(calls, 2);
});
