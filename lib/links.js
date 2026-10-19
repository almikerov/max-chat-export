import { localParts, sanitizeName } from './attachments.js';
import { CREDIT, escapeHtml, senderName } from './render.js';

// Ссылки из сообщений MAX: адреса в тексте, гиперссылки разметки (elements[] с attributes.url)
// и превью ссылок (вложение SHARE с заголовком). Формат: max-api-docs, elements.md и files.md;
// PyMax, ShareAttachment.
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
const LOOKS_LIKE_URL = /^(?:https?:\/\/|www\.)/i;

const count = (text, char) => text.split(char).length - 1;

// Хвостовая пунктуация — не часть адреса; закрывающая скобка — только если она без пары.
function trimUrl(raw) {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (/[.,;:!?'"»]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
    else return url;
  }
}

const normalize = (url) => (/^www\./i.test(url) ? `https://${url}` : url);

// Ссылки одного сообщения без повторов, в порядке появления. Заголовок — из превью
// или из слов, под которыми спрятана гиперссылка.
export function extractLinks(message) {
  const found = new Map();
  const add = (url, title = null) => {
    if (typeof url !== 'string' || !url.trim()) return;
    const key = normalize(url.trim());
    if (!found.has(key)) found.set(key, title || null);
    else if (title && !found.get(key)) found.set(key, title);
  };
  const text = String(message?.text ?? '');
  for (const m of text.matchAll(URL_IN_TEXT)) add(trimUrl(m[0]));
  for (const element of message?.elements ?? []) {
    const url = element?.attributes?.url;
    if (!url) continue;
    const from = element.from ?? 0;
    const words = text.slice(from, from + (element.length ?? 0)).trim();
    add(url, words && !LOOKS_LIKE_URL.test(words) ? words : null);
  }
  for (const attach of message?.attaches ?? []) {
    if (attach?._type === 'SHARE') add(attach.url, attach.title?.trim() || null);
  }
  return [...found].map(([url, title]) => ({ url, title }));
}

// Каждое появление ссылки — отдельная строка: когда, кто, что и в каком сообщении.
export function collectLinks(messages, names, timeZone) {
  return messages.flatMap((m) => extractLinks(m).map(({ url, title }) => {
    const { date, time } = localParts(m.time, timeZone);
    return {
      messageId: String(m.id),
      time: m.time,
      localTime: `${date} ${time.slice(0, 5).replace('-', ':')}`,
      senderName: senderName(m, names),
      url,
      title,
      text: m.text ?? '',
    };
  }));
}

function readable(url) {
  const raw = `${url.host}${url.pathname}`;
  let text;
  try {
    text = decodeURIComponent(raw);
  } catch {
    text = raw;
  }
  return text.replace(/\/+/g, ' ').trim();
}

// Ярлыки браузера (.url, Windows Internet Shortcut): двойной щелчок открывает ссылку.
// Один ярлык на адрес; имя — дата первого появления и заголовок или адрес без протокола.
// Адрес в ярлыке нормализован (кириллица в процент-кодировке), только http(s).
export function linkShortcuts(rows, timeZone) {
  const seen = new Set();
  const used = new Set();
  const files = [];
  for (const row of rows) {
    let url;
    try {
      url = new URL(row.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    const { date, time } = localParts(row.time, timeZone);
    const name = sanitizeName(row.title || readable(url), 'link').slice(0, 80).trim();
    let path = `Ссылки/${date}_${time}_${name}.url`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `Ссылки/${date}_${time}_${name}_${n}.url`;
    used.add(path.toLowerCase());
    files.push({ path, time: row.time, text: `[InternetShortcut]\r\nURL=${url.href}\r\n` });
  }
  return files;
}

// Excel в русской локали: UTF-8 с BOM, разделитель «;». Ячейка, похожая на формулу,
// получает апостроф, чтобы текст из чата не выполнился как формула.
function cell(value) {
  let text = String(value ?? '');
  if (/^[=+@\t\r]|^-\S/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function renderLinksCsv(rows) {
  const lines = [['Дата', 'Отправитель', 'Ссылка', 'Заголовок', 'Сообщение'],
    ...rows.map((r) => [r.localTime, r.senderName, r.url, r.title, r.text])];
  return `﻿${lines.map((line) => line.map(cell).join(';')).join('\r\n')}\r\n`;
}

export function renderLinksHtml({ chat, chatId, rows, exportedAt, timeZone }) {
  const title = escapeHtml(chat?.title ?? `Чат ${chatId}`);
  const body = rows.map((r) => {
    // Кликабельны только веб-адреса: javascript: и прочее из чата остаётся текстом.
    const web = /^https?:\/\//i.test(r.url);
    const label = escapeHtml(r.title || r.url);
    const link = web ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    const address = r.title ? `<div class="muted url">${escapeHtml(r.url)}</div>` : '';
    return `<tr><td class="muted">${escapeHtml(r.localTime)}</td><td>${escapeHtml(r.senderName)}</td><td>${link}${address}</td><td class="text">${escapeHtml(r.text)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ссылки — ${title}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:16px;background:#f4f5f7;color:#1c1e21}
h1{font-size:20px;margin:0 0 4px}.muted{color:#65676b;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;margin-top:12px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-top:1px solid #e4e6eb}th{font-size:13px;color:#65676b;border-top:0}
td:first-child{white-space:nowrap}.url{word-break:break-all}.text{white-space:pre-wrap;max-width:420px}
a{color:#2f6fed;word-break:break-word}
@media (prefers-color-scheme:dark){body{background:#18191a;color:#e4e6eb}table{background:#242526}th,td{border-color:#3a3b3c}.muted,th{color:#b0b3b8}a{color:#8ab4ff}}
</style></head><body>
<h1>Ссылки — ${title}</h1>
<div class="muted">Экспорт ${escapeHtml(new Date(exportedAt).toLocaleString('ru-RU', { timeZone }))} · Ссылок: ${rows.length}</div>
<table><thead><tr><th>Дата</th><th>Отправитель</th><th>Ссылка</th><th>Сообщение</th></tr></thead>
<tbody>
${body}
</tbody></table>
<footer class="muted" style="text-align:center;margin:24px 0 8px">${escapeHtml(CREDIT)}</footer>
</body></html>
`;
}
