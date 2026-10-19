// Фон и скрытый документ расширения с настоящей сборкой ZIP; сеть подменена.
import { createArchiveService } from '../lib/archive.js';
import { readZip } from './read-zip.js';

export function fakeExtension({ fetch = async (url) => new Response(`data of ${url}`), convertImage = async (blob) => blob } = {}) {
  const blobs = new Map();
  const saved = [];
  const service = createArchiveService({
    fetch, convertImage,
    createUrl: (blob) => {
      const url = `blob:zip-${blobs.size + 1}`;
      blobs.set(url, blob);
      return url;
    },
  });
  const offscreen = (msg) => service(msg).catch((error) => ({ error: error.message }));
  let nextId = 1;
  const background = async (msg) => {
    switch (msg.type) {
      case 'archiveOpen':
        return service({ type: 'zipOpen' });
      case 'archiveSave': {
        const { url } = await service({ type: 'zipClose', archive: msg.archive });
        saved.push({ filename: msg.filename, blob: blobs.get(url) });
        return { id: nextId++ };
      }
      case 'saveText':
        saved.push({ filename: msg.filename, text: msg.text });
        return { id: nextId++ };
      case 'downloadState':
        return { state: 'complete' };
      default:
        throw new Error(`unexpected ${msg.type}`);
    }
  };
  // Содержимое сохранённого архива: имя → текст.
  const archive = async (index = 0) => {
    const zip = saved.filter((s) => s.blob)[index];
    const { files } = readZip(new Uint8Array(await zip.blob.arrayBuffer()));
    return { filename: zip.filename, files: new Map(files.map((f) => [f.name, f.text])) };
  };
  return { background, offscreen, saved, archive };
}
