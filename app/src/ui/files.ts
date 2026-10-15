/** The files in a drop: files as they are, and folders read through (a writer's folder of
 *  readers' notes, a folder of books), a few levels deep, hidden files left out. The
 *  drop's entries are taken at once: the browser empties them after the event. */
export function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map(i => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e);
  const plain = [...dt.files];
  if (!entries.some(e => e.isDirectory)) return Promise.resolve(plain);
  return (async () => {
    const out: File[] = [];
    const walk = async (e: FileSystemEntry, depth: number): Promise<void> => {
      if (e.name.startsWith('.')) return;
      if (e.isFile) {
        out.push(await new Promise<File>((ok, no) => (e as FileSystemFileEntry).file(ok, no)));
      } else if (e.isDirectory && depth < 4) {
        const reader = (e as FileSystemDirectoryEntry).createReader();
        // (a folder is listed a batch at a time, until an empty one)
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
          if (!batch.length) break;
          for (const c of batch) await walk(c, depth + 1);
        }
      }
    };
    for (const e of entries) await walk(e, 0);
    return out;
  })();
}
