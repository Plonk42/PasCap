import { useState } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { ProjectDocument } from '../shared/model.js';
import { mediaRemovalUsage } from '../shared/projects.js';
import { durationLabel, MUSIC_DRAG_TYPE } from './display.js';
import { Icon } from './icons.js';
import type { RelinkTarget } from './ImportDialog.js';
import './music-ui.css';
import { RemoveMediaDialog } from './RemoveMediaDialog.js';

const STATUS: Record<AudioAsset['status'], string> = {
  ready: 'Ready',
  registered: 'Not prepared',
  queued: 'Queued',
  preparing: 'Preparing',
  error: 'Preparation failed',
};

export function musicMatchesFilter(
  asset: AudioAsset,
  project: ProjectDocument | null,
  search: string,
  filter: string,
): boolean {
  if (!asset.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false;
  if (filter === 'ready') return asset.status === 'ready';
  if (filter === 'unprepared') return asset.status !== 'ready';
  const used = project?.music.some((track) => track.mediaId === asset.id) ?? false;
  if (filter === 'used') return used;
  if (filter === 'unused') return !used;
  return true;
}

/** Imported music files in the project bin; adding them to the timeline stays in Audio. */
export function MediaMusicList({
  music,
  project,
  busy,
  missing,
  onPrepare,
  onRelink,
  onRemove,
}: Readonly<{
  music: readonly AudioAsset[];
  project: ProjectDocument | null;
  busy: boolean;
  missing: ReadonlySet<string>;
  onPrepare: (id: string) => Promise<void>;
  onRelink: (target: RelinkTarget | null) => void;
  onRemove: (ids: string[]) => boolean;
}>) {
  const [removing, setRemoving] = useState<string | null>(null);
  if (!music.length) return null;
  const tracks = (id: string): number => project?.music.filter((track) => track.mediaId === id).length ?? 0;
  const remove = (id: string): void => {
    const index = music.findIndex((asset) => asset.id === id);
    const neighbour = music[index + 1] ?? music[index - 1];
    setRemoving(null);
    if (!onRemove([id])) return;
    requestAnimationFrame(() => {
      const target = neighbour
        ? document.querySelector<HTMLElement>(`[data-music-media-id="${CSS.escape(neighbour.id)}"] .media-remove`)
        : document.querySelector<HTMLElement>('[aria-label="Search media"]');
      target?.focus();
    });
  };
  const requestRemove = (id: string): void => {
    if (!project || busy) return;
    if (mediaRemovalUsage(project, { videoIds: [], audioIds: [id] }).music > 0) setRemoving(id);
    else remove(id);
  };
  return (
    <section className="media-music" aria-label="Music recordings">
      <h3>
        Music <span className="count">{music.length}</span>
      </h3>
      {music.map((asset) => {
        const used = tracks(asset.id);
        const lost = missing.has(asset.id);
        const status = lost ? 'Original missing' : STATUS[asset.status];
        return (
          <article
            key={asset.id}
            className="media-music-item"
            data-music-media-id={asset.id}
            data-status={asset.status}
            draggable={asset.status === 'ready' && project !== null && !busy}
            title={asset.status === 'ready' ? 'Drag onto the music lane to add a music track' : undefined}
            onDragStart={(event) => {
              event.dataTransfer.setData(MUSIC_DRAG_TYPE, asset.id);
              event.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <span className="media-music-icon" aria-hidden="true">
              <Icon name="music" size={16} />
            </span>
            <span className="media-item-info" title={asset.sourcePath}>
              <strong>{asset.name}</strong>
              <span className="media-recording-meta">
                <span className="media-recording-duration">{durationLabel(asset.metadata.durationSeconds)}</span>
                {used > 0 && (
                  <span className="media-usage-badge">
                    {used} {used === 1 ? 'music track' : 'music tracks'}
                  </span>
                )}
                {(asset.status !== 'ready' || lost) && <span className="media-status-text">{status}</span>}
              </span>
            </span>
            {lost && (
              <button
                className="icon-button relink-media"
                aria-label={`Relink ${asset.name}`}
                title={`Original missing at ${asset.sourcePath}. Relink it to its moved copy`}
                disabled={busy}
                onClick={() =>
                  onRelink({ kind: 'audio', id: asset.id, name: asset.name, sourcePath: asset.sourcePath })
                }
              >
                <Icon name="link" size={15} />
              </button>
            )}
            {!lost && (asset.status === 'registered' || asset.status === 'error') && (
              <button
                className="icon-button prepare-media"
                aria-label={`Prepare ${asset.name}`}
                title={asset.error ?? 'Prepare'}
                disabled={busy}
                onClick={() => {
                  void onPrepare(asset.id);
                }}
              >
                <Icon name={asset.status === 'error' ? 'reset' : 'wand'} size={15} />
              </button>
            )}
            <button
              className="icon-button media-remove"
              aria-label={`Remove ${asset.name} from project`}
              title="Remove from this project; the original recording is kept"
              disabled={!project || busy}
              onClick={() => requestRemove(asset.id)}
            >
              <Icon name="trash" size={14} />
            </button>
          </article>
        );
      })}
      {removing && project && (
        <RemoveMediaDialog
          names={[music.find((asset) => asset.id === removing)?.name ?? removing]}
          clips={0}
          music={mediaRemovalUsage(project, { videoIds: [], audioIds: [removing] }).music}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </section>
  );
}
