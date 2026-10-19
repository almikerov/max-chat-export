// Агент во вкладке web.max.ru (изолированный мир content script).
// Принимает команды всплывающего окна, говорит с page-hook.js через postMessage
// и ведёт экспорт, пока вкладка открыта. Логика — в lib/agent-core.js.
(() => {
  const FROM_EXT = 'mce:ext';
  const FROM_PAGE = 'mce:page';
  let nextId = 1;
  const waiting = new Map();

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || msg?.source !== FROM_PAGE) return;
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    msg.ok ? w.resolve(msg.data) : w.reject(new Error(msg.data));
  });

  function page(type, extra = {}, timeoutMs = 0) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      if (timeoutMs) {
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error('страница MAX не отвечает — обновите вкладку'));
        }, timeoutMs);
      }
      window.postMessage({ ...extra, id, type, source: FROM_EXT }, location.origin);
    });
  }

  const background = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'background' });
  // Скрытый документ собирает ZIP; сообщения ему идут напрямую, мимо засыпающего фона.
  const offscreen = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
  const notify = (state) => chrome.runtime.sendMessage({ target: 'progress', state }).catch(() => {});

  const agent = import(chrome.runtime.getURL('lib/agent-core.js'))
    .then(({ createAgent }) => createAgent({ page, background, offscreen, notify }));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'agent') return false;
    agent
      .then((a) => a.handle(msg))
      .then(sendResponse, (error) => sendResponse({ error: error.message }));
    return true;
  });
})();
