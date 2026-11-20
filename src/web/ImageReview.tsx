import { useState, type KeyboardEvent } from 'react';
import { imageFileUrl, type ImageAsset } from '../shared/images.js';
import { setColorReference, useColorReference } from './color-reference.js';
import { Icon } from './icons.js';
import './media-images.css';

/** An imported still image shown whole in Source preview, which Color → Match can take as its reference. */
export function ImageReview({
  image,
  missing,
  projectId,
  onClose,
}: Readonly<{
  image: ImageAsset;
  missing: boolean;
  projectId: string | null;
  onClose: () => void;
}>) {
  const reference = useColorReference(projectId);
  const chosen = reference?.kind === 'image' && reference.imageId === image.id;
  const url = imageFileUrl(image);
  const [failed, setFailed] = useState<string | null>(null);
  let unavailable = '';
  if (missing) unavailable = `Original missing at ${image.sourcePath}`;
  else if (failed === url) unavailable = 'This image cannot be shown.';
  const keyboard = (event: KeyboardEvent<HTMLElement>): void => {
    // Space reaches the editor shortcut; there is nothing to play here.
    if (event.code === 'Space') return;
    event.stopPropagation();
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <section className="source-review rush-source image-review" aria-label="Image review" data-image-id={image.id}>
      <div className="source-review-heading">
        <div>
          <div className="source-review-title">
            <strong title={`${image.sourcePath} · ${image.width} × ${image.height}`}>{image.name}</strong>
          </div>
        </div>
        <button
          className="secondary-button small source-color-reference"
          type="button"
          aria-label="Use this image as the color reference"
          aria-pressed={chosen}
          title={
            chosen
              ? 'This image is the Color → Match reference'
              : 'Use this image, as shot, as the reference Color → Match grades clips to look like'
          }
          disabled={projectId === null}
          onKeyDown={keyboard}
          onClick={() => {
            if (projectId !== null) setColorReference(projectId, { kind: 'image', imageId: image.id });
          }}
        >
          <Icon name="wand" size={13} />
          <span>Use as reference</span>
        </button>
        <button
          className="icon-button"
          aria-label="Close source review"
          title="Close source review"
          onKeyDown={keyboard}
          onClick={onClose}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="source-preview image-review-picture">
        {unavailable ? (
          <div className="source-preview-overlay source-preview-error">
            <span role="alert">{unavailable}</span>
          </div>
        ) : (
          <img src={url} alt={image.name} decoding="async" draggable={false} onError={() => setFailed(url)} />
        )}
      </div>
    </section>
  );
}
