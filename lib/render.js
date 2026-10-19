import { KINDS, localParts } from './attachments.js';

export const CREDIT = 'Max-Chat-Export · автор: Александр Микеров';

export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function href(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function itemsByMessage(items) {
  const map = new Map();
  for (const item of items) {
    const key = String(item.message.id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function senderName(message, names) {
  if (message.sender === null || message.sender === undefined) return 'Канал';
  return names.get(String(message.sender)) ?? `ID ${message.sender}`;
}

export function renderJson({ chat, chatId, messages, names, items, options, exportedAt, timeZone }) {
  const byMessage = itemsByMessage(items);
  return JSON.stringify({
    chat: { id: String(chatId), title: chat?.title ?? null },
    exportedAt: new Date(exportedAt).toISOString(),
    options,
    messages: messages.map((m) => {
      const { date, time } = localParts(m.time, timeZone);
      return {
        id: String(m.id),
        time: m.time,
        localTime: `${date} ${time.replaceAll('-', ':')}`,
        senderId: m.sender === null || m.sender === undefined ? null : String(m.sender),
        senderName: senderName(m, names),
        text: m.text ?? '',
        attachments: (byMessage.get(String(m.id)) ?? []).map((i) => ({
          kind: i.kind, name: i.name, size: i.size, file: i.status === 'ok' ? i.path : null, status: i.status, error: i.error,
        })),
      };
    }),
  }, null, 2);
}

function renderAttachment(item) {
  const name = escapeHtml(item.name);
  const size = item.size ? ` <span class="muted">${formatSize(item.size)}</span>` : '';
  switch (item.status) {
    case 'ok':
      if (item.kind === 'photo') return `<a class="att" href="${href(item.path)}"><img src="${href(item.path)}" loading="lazy" alt="${name}"></a>`;
      if (item.kind === 'video') return `<a class="att" href="${href(item.path)}">▶ ${name}</a>`;
      return `<a class="att" href="${href(item.path)}">📎 ${name}</a>${size}`;
    case 'skipped-type':
      return `<span class="att muted">[${KINDS[item.kind].label}: не выгружалось — ${name}]</span>`;
    case 'skipped-size':
      return `<span class="att muted">[Больше лимита: ${name}${size}]</span>`;
    default:
      return `<span class="att failed">[Не скачано: ${name} — ${escapeHtml(item.error ?? 'ошибка')}]</span>`;
  }
}

export function renderHtml({ chat, chatId, messages, names, items, exportedAt, timeZone }) {
  const byMessage = itemsByMessage(items);
  const title = escapeHtml(chat?.title ?? `Чат ${chatId}`);
  let lastDate = null;
  const rows = [];
  for (const m of messages) {
    const { date, time } = localParts(m.time, timeZone);
    if (date !== lastDate) {
      rows.push(`<h2>${date}</h2>`);
      lastDate = date;
    }
    const text = m.text ? `<div class="text">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>` : '';
    const atts = (byMessage.get(String(m.id)) ?? []).map(renderAttachment).join('');
    rows.push(`<div class="msg"><div class="head"><b>${escapeHtml(senderName(m, names))}</b> <span class="muted">${time.slice(0, 5).replace('-', ':')}</span></div>${text}${atts ? `<div class="atts">${atts}</div>` : ''}</div>`);
  }
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px;background:#f4f5f7;color:#1c1e21}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#65676b;text-align:center;margin:24px 0 8px}
.msg{background:#fff;border-radius:10px;padding:8px 12px;margin:6px 0}.head{margin-bottom:2px}
.muted{color:#65676b;font-size:13px}.failed{color:#b3261e;font-size:13px}
.atts{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.att img{max-width:240px;max-height:240px;border-radius:6px;display:block}
@media (prefers-color-scheme:dark){body{background:#18191a;color:#e4e6eb}.msg{background:#242526}.muted,h2{color:#b0b3b8}}
</style></head><body>
<h1>${title}</h1>
<div class="muted">Экспорт ${escapeHtml(new Date(exportedAt).toLocaleString('ru-RU', { timeZone }))} · сообщений: ${messages.length}</div>
${rows.join('\n')}
<footer class="muted" style="text-align:center;margin:24px 0 8px">${escapeHtml(CREDIT)}</footer>
</body></html>
`;
}

// Скорость чтения истории: по ней видно, сколько сообщений MAX реально отдаёт за запрос.
function historyLine(h) {
  if (!h) return [];
  const seconds = h.ms / 1000;
  const rate = seconds > 0 ? `, ${Math.round(h.messages / seconds)} сообщ./с` : '';
  return [`История: ${h.messages} сообщений за ${seconds.toFixed(1)} с${rate}; запросов ${h.pages}, просили по ${h.pageSize}, максимум за запрос пришло ${h.largestPage}`];
}

export function renderReport({ archive, chat, chatId, messages, items, history, startedAt, finishedAt }) {
  const lines = [
    CREDIT,
    `Экспорт чата MAX: ${chat?.title ?? chatId}`,
    `Архив: ${archive}`,
    `Время: ${new Date(startedAt).toISOString()} — ${new Date(finishedAt).toISOString()}`,
    `Сообщений: ${messages.length}`,
    ...historyLine(history),
    '',
    'Вложения:',
  ];
  for (const [kind, { label }] of Object.entries(KINDS)) {
    const own = items.filter((i) => i.kind === kind);
    if (!own.length) continue;
    const count = (s) => own.filter((i) => i.status === s).length;
    lines.push(`  ${label}: всего ${own.length}, скачано ${count('ok')}, ошибок ${count('failed')}, пропущено по типу ${count('skipped-type')}, больше лимита ${count('skipped-size')}`);
  }
  const failed = items.filter((i) => i.status === 'failed');
  if (failed.length) {
    lines.push('', 'Не скачано:');
    for (const i of failed) lines.push(`  ${i.path ?? i.name} — ${i.error}`);
  }
  return lines.join('\n') + '\n';
}
