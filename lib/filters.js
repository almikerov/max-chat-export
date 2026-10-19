// Фильтры строк окна: регулярные выражения без учёта регистра.
// Сообщения — по тексту, ссылки — по адресу и заголовку, вложения — по имени файла.
const LABELS = { messages: 'Сообщения', links: 'Ссылки', photo: 'Фото', video: 'Видео', file: 'Файлы', audio: 'Голосовые' };

// Пустой фильтр не фильтрует. Ошибка в выражении называет строку, чтобы её было легко найти.
export function compileFilters(filters = {}) {
  const compiled = {};
  for (const [row, source] of Object.entries(filters ?? {})) {
    if (typeof source !== 'string' || !source.trim()) continue;
    try {
      compiled[row] = new RegExp(source, 'i');
    } catch (error) {
      throw new Error(`неверный фильтр «${LABELS[row] ?? row}»: ${error.message}`);
    }
  }
  return compiled;
}
