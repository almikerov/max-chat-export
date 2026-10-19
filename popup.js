import { KINDS } from './lib/attachments.js';
import { formatSize } from './lib/render.js';

const $ = (id) => document.getElementById(id);
const OPTIONS_KEY = 'mce-options';
const VIEWS = ['notice', 'form', 'progress'];

let tab = null;
let preferredChatId = null;
let poll = null;
let lastDownloadId = null;

// ---------- связь с вкладкой MAX ----------

async function agent(type, extra = {}) {
  const response = await chrome.tabs.sendMessage(tab.id, { target: 'agent', type, ...extra });
  if (!response) throw new Error('вкладка MAX не ответила');
  if (response.error) throw new Error(response.error);
  return response;
}

function chatIdFromUrl(url) {
  try {
    const m = /^\/(-?\d+)(?:\/|$)/.exec(new URL(url).pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function findMaxTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith('https://web.max.ru/')) return active;
  const all = await chrome.tabs.query({ url: 'https://web.max.ru/*' });
  return all[0] ?? null;
}

// ---------- экраны ----------

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
}

function notice(text, label, action) {
  $('noticeText').textContent = text;
  const button = $('noticeAction');
  button.hidden = !label;
  button.textContent = label ?? '';
  button.onclick = action;
  show('notice');
}

// ---------- открытый чат ----------

let currentChat = null;

async function loadChat() {
  const name = $('chatName');
  const hint = $('chatHint');
  $('start').disabled = true;
  name.textContent = 'Определяю чат…';
  name.className = 'chat-name muted';
  hint.textContent = '';
  hint.className = 'hint';

  const info = await agent('chat', { chatId: preferredChatId }).catch((error) => ({ error: error.message }));
  currentChat = { id: preferredChatId, title: info.title ?? null };
  name.textContent = info.title ?? `Чат ${preferredChatId}`;
  name.className = info.title ? 'chat-name' : 'chat-name muted';
  if (info.error) {
    hint.textContent = `MAX не ответил: ${info.error}. Нажмите «Диагностика» внизу и пришлите файл.`;
    hint.className = 'hint bad';
  }
  $('start').disabled = false;
}

// ---------- настройки ----------

const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
const IMAGE_FORMATS = ['jpg', 'png', 'original'];

function dayStart(value, endOfDay) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
}

function readOptions() {
  const formats = checked('format');
  const maxMb = Number($('maxMb').value) || null;
  return {
    formats: { html: formats.includes('html'), json: formats.includes('json') },
    kinds: checked('kind'),
    fromMs: dayStart($('from').value, false),
    toMs: dayStart($('to').value, true),
    maxBytes: maxMb ? maxMb * 1024 * 1024 : null,
    imageFormat: checked('imageFormat')[0] ?? 'jpg',
  };
}

function saveForm() {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({
      formats: checked('format'), kinds: checked('kind'), imageFormat: checked('imageFormat')[0],
      from: $('from').value, to: $('to').value, maxMb: $('maxMb').value,
    }));
  } catch { /* не критично */ }
}

function restoreForm() {
  let form = null;
  try {
    form = JSON.parse(localStorage.getItem(OPTIONS_KEY));
  } catch { /* нет сохранённого */ }
  if (!form) return;
  for (const input of document.querySelectorAll('input[name="format"]')) input.checked = form.formats.includes(input.value);
  for (const input of document.querySelectorAll('input[name="kind"]')) input.checked = form.kinds.includes(input.value);
  const imageFormat = IMAGE_FORMATS.includes(form.imageFormat) ? form.imageFormat : 'jpg';
  for (const input of document.querySelectorAll('input[name="imageFormat"]')) input.checked = input.value === imageFormat;
  $('from').value = form.from ?? '';
  $('to').value = form.to ?? '';
  $('maxMb').value = form.maxMb ?? '';
}

// ---------- прогресс ----------

function stageText(p) {
  const text = stageName(p);
  return p?.retry ? `${text} Связь с MAX прервалась — жду переподключения (повтор ${p.retry})…` : text;
}

function stageName(p) {
  switch (p?.stage) {
    case 'history': return `Читаю историю… сообщений: ${p.count ?? 0}`;
    case 'names': return 'Получаю имена участников…';
    case 'files': return p.total ? `Скачиваю вложения в архив: ${p.done} из ${p.total}` : 'Вложений для скачивания нет';
    case 'writing': return 'Собираю архив…';
    default: return 'Готовлюсь…';
  }
}

function renderProgress(s) {
  show('progress');
  $('progressTitle').textContent = s.title ? `Чат «${s.title}»` : 'Экспорт';
  const bar = $('bar');
  const p = s.progress;
  if (s.running && p?.stage === 'files' && p.total) {
    bar.max = p.total;
    bar.value = p.done;
  } else if (s.running) {
    bar.removeAttribute('value');
  } else {
    bar.max = 1;
    bar.value = s.error ? 0 : 1;
  }

  if (s.running) $('progressText').textContent = stageText(p);
  else if (s.error) $('progressText').textContent = `Экспорт остановлен: ${s.error}`;
  else if (s.summary) {
    const m = s.summary;
    const history = m.history ? ` История прочитана за ${(m.history.ms / 1000).toFixed(1)} с.` : '';
    $('progressText').textContent = `Готово: сообщений ${m.messages}, файлов в архиве ${m.downloaded}, не скачано ${m.failed}, пропущено ${m.skipped}.${history} Архив: Загрузки/${m.archive}`;
  }

  lastDownloadId = s.lastDownloadId;
  $('openFolder').hidden = s.running || !lastDownloadId;
  $('again').hidden = s.running;

  const list = $('log');
  list.innerHTML = '';
  for (const entry of s.log ?? []) {
    const li = document.createElement('li');
    const size = entry.size ? ` (${formatSize(entry.size)})` : '';
    if (entry.status === 'ok') li.textContent = `${KINDS[entry.kind]?.label ?? entry.kind}: ${entry.name}${size}`;
    else {
      li.textContent = `Не скачано: ${entry.name} — ${entry.error}`;
      li.className = 'bad';
    }
    list.append(li);
  }
}

function watch() {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const { export: s } = await agent('status');
      renderProgress(s);
      if (!s.running) clearInterval(poll);
    } catch { /* вкладку закрыли — оставляем последнее состояние */ }
  }, 1000);
}

globalThis.chrome?.runtime?.onMessage?.addListener((msg) => {
  if (msg?.target === 'progress' && !$('progress').hidden) renderProgress(msg.state);
  return false;
});

// ---------- действия ----------

for (const input of document.querySelectorAll('#form input')) input.addEventListener('change', saveForm);

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const options = readOptions();
  const error = $('formError');
  if (!options.formats.html && !options.formats.json && !options.kinds.length) {
    error.textContent = 'Выберите формат истории или хотя бы один тип вложений.';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  saveForm();
  const { id: chatId, title } = currentChat;
  try {
    await agent('start', { chatId, title, options });
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
    return;
  }
  renderProgress({ running: true, title, progress: { stage: 'history', count: 0 }, log: [] });
  watch();
});

$('again').addEventListener('click', async () => {
  show('form');
  await loadChat();
});

$('openFolder').addEventListener('click', () => {
  if (lastDownloadId) chrome.runtime.sendMessage({ target: 'background', type: 'show', id: lastDownloadId });
});

$('diag').addEventListener('click', async () => {
  const button = $('diag');
  try {
    await agent('diag');
    button.textContent = 'Сохранено в Загрузки/Max-Chat-Export';
  } catch (e) {
    button.textContent = `Ошибка: ${e.message}`;
  }
});

// ---------- запуск ----------

async function init() {
  restoreForm();
  tab = await findMaxTab();
  if (!tab) {
    notice('Откройте web.max.ru в этом браузере и войдите в аккаунт.', 'Открыть MAX', () => chrome.tabs.create({ url: 'https://web.max.ru/' }));
    return;
  }
  preferredChatId = chatIdFromUrl(tab.url);

  let status;
  try {
    status = await agent('status');
  } catch {
    status = null;
  }
  if (!status || status.pageError) {
    notice(
      'Расширение ещё не подключено к вкладке MAX. Обновите её — это нужно один раз после установки или обновления расширения.',
      'Обновить вкладку MAX',
      async () => {
        await chrome.tabs.reload(tab.id);
        window.close();
      },
    );
    return;
  }
  $('diag').hidden = false;

  const s = status.export;
  if (s.running || s.summary || s.error) {
    renderProgress(s);
    if (s.running) watch();
    return;
  }
  if (!status.page?.appSocket && !status.page?.loggedIn) {
    notice('Не вижу входа в MAX. Войдите в аккаунт во вкладке MAX и откройте это окно снова.', 'Перейти во вкладку MAX', () => chrome.tabs.update(tab.id, { active: true }));
    return;
  }
  if (!preferredChatId) {
    notice('Откройте нужный чат во вкладке MAX и снова нажмите на значок расширения.', 'Перейти во вкладку MAX', () => chrome.tabs.update(tab.id, { active: true }));
    return;
  }
  show('form');
  await loadChat();
}

// popup.html?demo вне расширения — макет окна для проверки вёрстки.
function demo() {
  preferredChatId = '-72013802979440';
  currentChat = { id: preferredChatId, title: 'Пример чата' };
  $('chatName').textContent = currentChat.title;
  show('form');
  $('diag').hidden = false;
}

if (globalThis.chrome?.tabs) init();
else if (location.search.includes('demo')) demo();
