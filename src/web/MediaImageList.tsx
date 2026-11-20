import { useState } from 'react';
import { imageFileUrl, type ImageAsset } from '../shared/images.js';
import { useColorReference } from './color-reference.js';
import { Icon } from './icons.js';
import './media-images.css';

export function imageMatchesFilter(
  image: ImageAsset,
  missing: ReadonlySet<string>,
  search: string,
  filter: string,
): boolean {
  if (!image.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false;
  // Images need no preparation and never go on the timeline.
  return filter === 'all' || (filter === 'ready' && !missing.has(image.id));
}

/** A thumbnail of the original itself; an unreadable one shows the image icon. */
function ImageThumbnail({ image, lost }: Readonly<{ image: ImageAsset; lost: boolean }>) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = imageFileUrl(image);
  return (
    <span className="media-image-thumb" aria-hidden="true">
      {lost || failed === url ? (
        <Icon name="mountain" size={16} />
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(url)} />
      )}
    </span>
  );
}

/** Imported still images in the project bin, shown in Source preview, where Color → Match can take one as its reference. */
export function MediaImageList({
  images,
  projectId,
  busy,
  missing,
  reviewing,
  onReview,
  onRemove,
}: Readonly<{
  images: readonly ImageAsset[];
  projectId: string | null;
  busy: boolean;
  missing: ReadonlySet<string>;
  /** The image shown in Source preview, and showing one there. */
  reviewing: string | null;
  onReview: (id: string) => void;
  onRemove: (ids: string[]) => boolean;
}>) {
  const reference = useColorReference(projectId);
  if (!images.length) return null;
  const remove = (id: string): void => {
    const index = images.findIndex((image) => image.id === id);
    const neighbor = images[index + 1] ?? images[index - 1];
    if (!onRemove([id])) return;
    requestAnimationFrame(() => {
      const target = neighbor
        ? document.querySelector<HTMLElement>(`[data-image-id="${CSS.escape(neighbor.id)}"] .media-remove`)
        : document.querySelector<HTMLElement>('[aria-label="Search media"]');
      target?.focus();
    });
  };
  return (
    <section className="media-images" aria-label="Images">
      <h3>
        Images <span className="count">{images.length}</span>
      </h3>
      {images.map((image) => {
        const lost = missing.has(image.id);
        const chosen = reference?.kind === 'image' && reference.imageId === image.id;
        const shown = reviewing === image.id;
        return (
          <article
            key={image.id}
            className={`media-image-item ${chosen ? 'reference' : ''} ${shown ? 'reviewing' : ''}`}
            data-image-id={image.id}
          >
            <button
              type="button"
              className="media-image-main"
              aria-label={`Show ${image.name} in Source preview`}
              aria-pressed={shown}
              title={`Show in Source preview${chosen ? ' · the Color → Match reference' : ''} · ${image.sourcePath}`}
              onClick={() => onReview(image.id)}
            >
              <ImageThumbnail image={image} lost={lost} />
              <span className="media-item-info">
                <strong>{image.name}</strong>
                <span className="media-recording-meta">
                  <span>
                    {image.width} × {image.height} · {image.format.toUpperCase()}
                  </span>
                  {chosen && <span className="media-usage-badge">Color reference</span>}
                  {lost && <span className="media-status-text">Original missing</span>}
                </span>
              </span>
            </button>
            <button
              className="icon-button media-remove"
              aria-label={`Remove ${image.name} from project`}
              title="Remove from this project; the original image is kept"
              disabled={projectId === null || busy}
              onClick={() => remove(image.id)}
            >
              <Icon name="trash" size={14} />
            </button>
          </article>
        );
      })}
    </section>
  );
}
