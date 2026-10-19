import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../lib/plan.js';
import { fakeMax, makeMessages, T0 } from './fake-max.js';

const MSK = 'Europe/Moscow';
const NOW = Date.UTC(2026, 9, 19, 18, 5, 0); // 19.10.2026 21:05 МСК

function chatWithAttachments() {
  const messages = makeMessages(5);
  messages[0].text = '<script>alert(1)</script>\nвторая строка';
  messages[1].attaches = [{ _type: 'FILE', fileId: 501, name: 'Document тренировка.xlsx', size: 4096 }];
  messages[2].attaches = [{ _type: 'VIDEO', videoId: 16508201099037, token: 'vt' }, { _type: 'PHOTO', photoId: 7, baseUrl: 'https://i.oneme.ru/i?r=7' }];
  messages[3].attaches = [{ _type: 'FILE', fileId: 502, name: 'битый.pdf', size: 10 }];
  messages[4].attaches = [{ _type: 'CONTROL', action: 'botStarted', deleted: true }];
  return messages;
}

// Архив в памяти: что в него положили и под каким именем сохранили.
function fakeArchive({ failDownload = () => false, saveAs = (entry) => entry.path, onAdd = async () => {} } = {}) {
  const archive = {
    added: [], files: new Map(), saved: [], dropped: false,
    add: async (entry) => {
      if (failDownload(entry.url)) throw new Error('NETWORK_FAILED');
      await onAdd(entry);
      archive.added.push(entry);
      return { path: saveAs(entry), size: 100 };
    },
    text: async (path, text) => { archive.files.set(path, text); },
    save: async (name) => { archive.saved.push(name); },
    drop: async () => { archive.dropped = true; },
  };
  return archive;
}

async function exportWith(options, { failFileIds = [], failDownload } = {}) {
  const { request, calls } = fakeMax(chatWithAttachments(), { failFileIds });
  const archive = fakeArchive({ failDownload });
  const downloads = archive.added;
  const files = archive.files;
  const progress = [];
  const result = await runExport({
    request,
    archive,
    chatId: -72013736853616,
    options,
    now: NOW,
    timeZone: MSK,
    delayMs: 0,
    onProgress: (p) => progress.push(p.stage),
  });
  return { result, calls, downloads, files, progress, archive };
}

const ALL = { formats: { html: true, json: true }, kinds: ['photo', 'video', 'file', 'audio'], fromMs: null, toMs: null, maxBytes: null };

test('runExport packs every selected attachment into one archive with a folder per type', async () => {
  const { result, downloads, files, calls, progress, archive } = await exportWith(ALL, { failFileIds: ['502'] });
  const name = 'Max-Chat-Export/Пример чата_2026-10-19_21-05.zip';
  assert.equal(result.archive, name);
  assert.deepEqual(archive.saved, [name]);
  assert.equal(result.messages, 4, 'service CONTROL message is dropped');
  assert.deepEqual(downloads.map((d) => [d.url, d.path, d.image]).sort(), [
    ['https://cdn/1080.mp4', 'Видео/2026-10-18_19-32-00_video_16508201099037.mp4', null],
    ['https://fd.oneme.ru/f/501', 'Файлы/2026-10-18_19-31-00_Document тренировка.xlsx', null],
    ['https://i.oneme.ru/i?r=7', 'Фото/2026-10-18_19-32-00_photo_7.jpg', 'jpg'],
  ]);
  assert.equal(result.downloaded, 3);
  assert.equal(result.failed, 1);
  assert.deepEqual([...files.keys()].sort(), ['messages.html', 'messages.json', 'report.txt']);
  assert.match(files.get('report.txt'), /битый\.pdf — FILE_NOT_FOUND/);
  assert.match(files.get('report.txt'), /История: 5 сообщений за .* просили по 1000/);
  const videoCall = calls.find((c) => c.opcode === 83);
  assert.equal(videoCall.payload.messageId.__mce_raw__, '116762160362694585');
  assert.equal(videoCall.payload.token, 'vt');
  assert.deepEqual([progress[0], progress.at(-1)], ['history', 'done']);
});

test('HTML history escapes message text and links downloaded files relatively', async () => {
  const { files, result } = await exportWith(ALL);
  const html = files.get('messages.html');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;<br>вторая строка'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes(`href="${encodeURIComponent('Файлы')}/${encodeURIComponent('2026-10-18_19-31-00_Document тренировка.xlsx')}"`));
  assert.ok(html.includes('<b>Тренер</b>'));
});

test('JSON history carries names and local files but no phone numbers', async () => {
  const { files, result } = await exportWith(ALL);
  const json = JSON.parse(files.get('messages.json'));
  assert.equal(json.chat.title, 'Пример чата');
  assert.equal(json.messages[1].senderName, 'Тренер');
  assert.equal(json.messages[1].attachments[0].file, 'Файлы/2026-10-18_19-31-00_Document тренировка.xlsx');
  assert.equal(json.messages[0].localTime, '2026-10-18 19:30:00');
  assert.ok(!files.get('messages.json').includes('+7'));
});

test('only selected types are downloaded; history formats are optional', async () => {
  const { downloads, files, result, calls } = await exportWith({ ...ALL, formats: { html: false, json: false }, kinds: ['file'] });
  assert.deepEqual(downloads.map((d) => d.url).sort(), ['https://fd.oneme.ru/f/501', 'https://fd.oneme.ru/f/502']);
  assert.deepEqual([...files.keys()], ['report.txt']);
  assert.ok(!calls.some((c) => c.opcode === 83), 'videos are not even resolved');
  assert.equal(result.skipped, 2);
});

test('a failed download is reported, not retried, and does not stop the export', async () => {
  const { result, files } = await exportWith(ALL, { failDownload: (url) => url.endsWith('1080.mp4') });
  assert.equal(result.failed, 1);
  assert.equal(result.downloaded, 3);
  assert.match(files.get('report.txt'), /video_16508201099037\.mp4 — NETWORK_FAILED/);
});

test('HTML and JSON use saved and public names and keep senders without available profiles visible', async () => {
  const messages = makeMessages(3).map((m, i) => ({ ...m, sender: 42 + i }));
  const { request } = fakeMax(messages);
  const archive = fakeArchive();
  const files = archive.files;
  const result = await runExport({
    request: async (opcode, payload) => opcode === 32 ? { contacts: [
      { id: 42, names: [{ type: 'ONEME', name: 'Мария' }, { type: 'CUSTOM', name: 'Контакт' }], phone: 'private-phone' },
      { id: 43, names: [{ type: 'ONEME', firstName: 'Иван', lastName: 'Сидоров' }] },
    ] } : request(opcode, payload),
    archive, chatId: -72013736853616, options: ALL, now: NOW, timeZone: MSK, delayMs: 0,
  });
  const json = JSON.parse(files.get('messages.json'));
  assert.deepEqual(json.messages.map((m) => m.senderName), ['Контакт', 'Иван Сидоров', 'ID 44']);
  const html = files.get('messages.html');
  for (const name of ['Контакт', 'Иван Сидоров', 'ID 44']) assert.ok(html.includes(`<b>${name}</b>`));
  assert.ok(!JSON.stringify([...files.values()]).includes('private-phone'));
});

test('the resolved popup name also titles exported histories and the archive', async () => {
  const { request } = fakeMax([], { chat: { id: 123, type: 'DIALOG', title: 'Мария' } });
  const archive = fakeArchive();
  const files = archive.files;
  const result = await runExport({
    request, archive, chatId: 123, chatTitle: 'Контакт', options: ALL, now: NOW, timeZone: MSK, delayMs: 0,
  });
  assert.match(result.archive, /Контакт_.*\.zip$/);
  assert.equal(result.title, 'Контакт');
  assert.equal(JSON.parse(files.get('messages.json')).chat.title, 'Контакт');
  assert.match(files.get('messages.html'), /<h1>Контакт<\/h1>/);
});

const CLOSED = 'соединение MAX закрыто — повторите запрос';

function exportThrough(request, { sleeps = [], progress = [] } = {}) {
  return runExport({
    request, archive: fakeArchive(),
    chatId: -72013736853616, options: ALL, now: NOW, timeZone: MSK, delayMs: 0,
    sleep: async (ms) => { sleeps.push(ms); }, onProgress: (p) => progress.push(p),
  });
}

test('a MAX reconnect in the middle of a long history is waited out instead of failing the export', async () => {
  const { request } = fakeMax(makeMessages(120));
  let history = 0;
  const flaky = async (opcode, payload) => {
    if (opcode === 49) {
      history++;
      if (history === 2) throw new Error(CLOSED);
      if (history === 3) throw new Error('MAX не ответил за 20 с (опкод 49)');
    }
    return request(opcode, payload);
  };
  const progress = [];
  const sleeps = [];
  const result = await exportThrough(flaky, { sleeps, progress });
  assert.equal(result.messages, 120);
  assert.deepEqual(progress.filter((p) => p.retry).map((p) => [p.stage, p.retry]), [['history', 1], ['history', 2]]);
  assert.ok(sleeps.filter((ms) => ms >= 1000).length >= 2, 'pauses before each repeat');
});

test('a connection that never comes back fails the export after a few repeats', async () => {
  const { request } = fakeMax(makeMessages(450));
  let calls = 0;
  const dies = async (opcode, payload) => {
    if (calls++ === 0) return request(opcode, payload);
    throw new Error(CLOSED);
  };
  await assert.rejects(exportThrough(dies), /соединение MAX закрыто/);
  assert.equal(calls, 1 + 5, 'the first page, then one try and four repeats');
});

test('MAX answers with an error are not repeated', async () => {
  const { calls } = await exportWith(ALL, { failFileIds: ['502'] });
  assert.equal(calls.filter((c) => c.opcode === 88 && String(c.payload.fileId) === '502').length, 1);
});

test('the export makes no artificial pauses between MAX requests', async () => {
  const { request } = fakeMax(makeMessages(450));
  const sleeps = [];
  await runExport({
    request, archive: fakeArchive(),
    chatId: 1, options: ALL, now: NOW, timeZone: MSK, sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, []);
});

test('attachments download four at a time', async () => {
  const messages = makeMessages(10).map((m, i) => ({ ...m, attaches: [{ _type: 'PHOTO', photoId: i, baseUrl: `https://i.oneme.ru/i?r=${i}` }] }));
  const { request } = fakeMax(messages);
  let inFlight = 0;
  let most = 0;
  const result = await runExport({
    request, chatId: 1, options: ALL, now: NOW, timeZone: MSK,
    archive: fakeArchive({ onAdd: async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    } }),
  });
  assert.equal(result.downloaded, 10);
  assert.equal(most, 4);
});

test('a rate limit from MAX is waited out like a reconnect', async () => {
  const { request } = fakeMax(makeMessages(3));
  let limited = false;
  const result = await exportThrough(async (opcode, payload) => {
    if (opcode === 49 && !limited) { limited = true; throw new Error('too.many.requests'); }
    return request(opcode, payload);
  });
  assert.equal(result.messages, 3);
});

test('photos go into the archive in the chosen format and the HTML links the saved name', async () => {
  const messages = makeMessages(1);
  messages[0].attaches = [{ _type: 'PHOTO', photoId: 7, baseUrl: 'https://i.oneme.ru/i?r=7' }];
  for (const imageFormat of ['png', 'original']) {
    const { request } = fakeMax(messages);
    const ext = imageFormat === 'png' ? '.png' : '.webp';
    const archive = fakeArchive({ saveAs: (e) => e.path.replace(/\.jpg$/, ext) });
    await runExport({ request, archive, chatId: 1, options: { ...ALL, imageFormat }, now: NOW, timeZone: MSK });
    assert.equal(archive.added[0].image, imageFormat);
    const saved = `photo_7${ext}`;
    assert.ok(archive.files.get('messages.html').includes(`${encodeURIComponent('2026-10-18_19-30-00_')}${saved}`));
    assert.ok(JSON.parse(archive.files.get('messages.json')).messages[0].attachments[0].file.endsWith(saved));
  }
});

test('a failed export drops the unfinished archive and saves nothing', async () => {
  const archive = fakeArchive();
  const broken = async () => { throw new Error('Ошибка валидации'); };
  await assert.rejects(runExport({ request: broken, archive, chatId: 1, options: ALL, now: NOW, timeZone: MSK }), /Ошибка валидации/);
  assert.equal(archive.dropped, true);
  assert.deepEqual(archive.saved, []);
});

test('when MAX rejects the request format, other files of that type fail at once instead of being sent again', async () => {
  const messages = makeMessages(4);
  messages.forEach((m, i) => { m.attaches = [{ _type: 'FILE', fileId: 600 + i, name: `Вес ${i}.docx`, size: 10 }]; });
  const { request } = fakeMax(messages);
  let fileCalls = 0;
  const strict = async (opcode, payload) => {
    if (opcode === 88) {
      fileCalls++;
      throw new Error('Ошибка валидации (proto.payload: Expected number at 31)');
    }
    return request(opcode, payload);
  };
  const result = await runExport({ request: strict, archive: fakeArchive(), chatId: 1, options: ALL, now: NOW, timeZone: MSK });
  assert.equal(fileCalls, 1);
  assert.equal(result.failed, 4);
  assert.ok(result.items.every((i) => /proto\.payload/.test(i.error)));
});

test('file and video links are requested with the message ID as a number', async () => {
  const { calls } = await exportWith(ALL);
  for (const opcode of [88, 83]) {
    const { messageId } = calls.find((c) => c.opcode === opcode).payload;
    assert.equal(typeof messageId, 'object', 'beyond 2^53 the exact value travels as a raw number');
    assert.match(messageId.__mce_raw__, /^1167621603626945\d\d$/);
  }
});

test('files outside the chosen formats are listed as skipped by format in the report and the HTML', async () => {
  const { downloads, files, result } = await exportWith({ ...ALL, kinds: ['file'], fileTypes: ['pdf'] });
  assert.deepEqual(downloads.map((d) => d.url), ['https://fd.oneme.ru/f/502']);
  assert.match(files.get('report.txt'), /Файлы: всего 2, скачано 1, .*не тот формат 1/);
  assert.match(files.get('messages.html'), /\[Файл другого формата: Document тренировка\.xlsx\]/);
  assert.equal(result.skipped, 3, 'two by type, one by format');
});

test('links export: links.html and links.csv in the archive, alone or with the history', async () => {
  const messages = makeMessages(3);
  messages[0].text = 'отчёт https://drive.example/a';
  messages[2].attaches = [{ _type: 'SHARE', url: 'https://youtu.be/xyz', title: 'Голы тура' }];
  for (const html of [true, false]) {
    const { request } = fakeMax(messages);
    const archive = fakeArchive();
    const result = await runExport({
      request, archive, chatId: 1, now: NOW, timeZone: MSK,
      options: { ...ALL, formats: { html, json: false }, kinds: [], links: { html: true, csv: true } },
    });
    assert.deepEqual([...archive.files.keys()].sort(), [...(html ? ['messages.html'] : []), 'links.csv', 'links.html', 'report.txt'].sort());
    assert.match(archive.files.get('links.csv'), /"https:\/\/drive\.example\/a"/);
    assert.match(archive.files.get('links.html'), /Голы тура/);
    assert.match(archive.files.get('report.txt'), /Ссылок: 2/);
    assert.equal(result.links, 2);
  }
});

test('without the links row no link files are written', async () => {
  const { files } = await exportWith(ALL);
  assert.ok(!files.has('links.html') && !files.has('links.csv'));
});

test('links export adds browser shortcuts into the Ссылки folder', async () => {
  const messages = makeMessages(2);
  messages[0].text = 'отчёт https://drive.example/a и ещё раз https://drive.example/a';
  messages[1].text = 'видео https://youtu.be/xyz';
  const { request } = fakeMax(messages);
  const archive = fakeArchive();
  await runExport({ request, archive, chatId: 1, now: NOW, timeZone: MSK,
    options: { ...ALL, formats: {}, kinds: [], links: { shortcuts: true } } });
  assert.deepEqual([...archive.files.keys()].filter((k) => k.startsWith('Ссылки/')).sort(), [
    'Ссылки/2026-10-18_19-30-00_drive.example a.url',
    'Ссылки/2026-10-18_19-31-00_youtu.be xyz.url',
  ]);
});

test('row filters: messages by text, links by address or title, files by name', async () => {
  const messages = makeMessages(4);
  messages[0].text = 'Тренировка завтра https://youtu.be/train';
  messages[1].text = 'обед https://drive.example/menu';
  messages[2].attaches = [{ _type: 'FILE', fileId: 1, name: 'Отчет 14.10.pdf', size: 10 }];
  messages[3].attaches = [{ _type: 'FILE', fileId: 2, name: 'Вес.docx', size: 10 }];
  const { request } = fakeMax(messages);
  const archive = fakeArchive();
  const result = await runExport({ request, archive, chatId: 1, now: NOW, timeZone: MSK, options: {
    ...ALL, kinds: ['file'], links: { csv: true },
    filters: { messages: 'тренировк', links: 'youtu', file: '^отч' },
  } });
  const json = JSON.parse(archive.files.get('messages.json'));
  assert.deepEqual(json.messages.map((m) => m.text), ['Тренировка завтра https://youtu.be/train']);
  assert.match(archive.files.get('links.csv'), /youtu\.be\/train/);
  assert.doesNotMatch(archive.files.get('links.csv'), /drive\.example/);
  assert.deepEqual(archive.added.map((a) => a.path), ['Файлы/2026-10-18_19-32-00_Отчет 14.10.pdf']);
  const report = archive.files.get('report.txt');
  assert.match(report, /Сообщений: 1 \(по фильтру, из 4\)/);
  assert.match(report, /не подошло под фильтр 1/);
  assert.equal(result.messages, 1);
});

test('a broken filter stops the export before MAX is asked anything', async () => {
  let asked = 0;
  const archive = fakeArchive();
  await assert.rejects(runExport({ request: async () => { asked++; return {}; }, archive, chatId: 1, now: NOW, timeZone: MSK,
    options: { ...ALL, filters: { messages: '([' } } }), /неверный фильтр «Сообщения»/);
  assert.equal(asked, 0);
  assert.deepEqual(archive.saved, []);
});

test('only the chosen senders are exported: messages, links and attachments', async () => {
  const messages = makeMessages(4).map((m, i) => ({ ...m, sender: [42, 43, 555, 43][i] }));
  messages[0].text = 'от Контакт https://youtu.be/a';
  messages[1].text = 'от тренера https://youtu.be/b';
  messages[2].attaches = [{ _type: 'FILE', fileId: 1, name: 'мой.pdf', size: 10 }];
  messages[3].attaches = [{ _type: 'FILE', fileId: 2, name: 'тренера.pdf', size: 10 }];
  const { request } = fakeMax(messages);
  const archive = fakeArchive();
  await runExport({ request, archive, chatId: 1, now: NOW, timeZone: MSK, options: {
    ...ALL, kinds: ['file'], links: { csv: true }, senders: ['42', '555'],
  } });
  assert.deepEqual(JSON.parse(archive.files.get('messages.json')).messages.map((m) => m.senderId), ['42', '555']);
  assert.match(archive.files.get('links.csv'), /youtu\.be\/a/);
  assert.doesNotMatch(archive.files.get('links.csv'), /youtu\.be\/b/);
  assert.deepEqual(archive.added.map((a) => a.path), ['Файлы/2026-10-18_19-32-00_мой.pdf']);
  assert.match(archive.files.get('report.txt'), /Отправители: выбрано 2/);
});
