import type { ProjectDocument } from '../shared/model.js';

const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;

interface WritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface SaveFileHandle {
  createWritable(): Promise<WritableFile>;
}
type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

export type ProjectFileWriter = (document: ProjectDocument) => Promise<void>;

export function projectFileName(title: string): string {
  const stem = title.replaceAll(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  return `${stem || 'Project'}.pascap.json`;
}

function contents(document: ProjectDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Asks where to save before anything is awaited, while the click still allows a file dialog.
 * Browsers without a save dialog download the file instead. Returns null when canceled.
 */
export async function chooseProjectFile(title: string): Promise<ProjectFileWriter | null> {
  const name = projectFileName(title);
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (!picker)
    return (document) => {
      download(name, contents(document));
      return Promise.resolve();
    };
  let handle: SaveFileHandle;
  try {
    handle = await picker.call(window, {
      suggestedName: name,
      types: [{ description: 'PasCap project', accept: { 'application/json': ['.json'] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  return async (document) => {
    const file = await handle.createWritable();
    await file.write(contents(document));
    await file.close();
  };
}

export async function readProjectFile(file: File): Promise<unknown> {
  if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('This file is larger than the 16 MiB project limit.');
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error('This file is not a PasCap project file: it does not contain JSON.');
  }
}
