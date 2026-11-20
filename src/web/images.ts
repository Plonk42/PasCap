import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ImageAsset } from '../shared/images.js';
import { api } from './api.js';

interface Registry {
  images: readonly ImageAsset[];
  missing: ReadonlySet<string>;
}

const EMPTY: Registry = { images: [], missing: new Set() };

/**
 * The registered images of the open project's library, read only once it holds images unknown to this page, and
 * whether each original is still in place.
 */
export function useProjectImages(imageIds: readonly string[] | undefined): {
  images: readonly ImageAsset[];
  missing: ReadonlySet<string>;
  /** Images just registered by an import. */
  add: (images: readonly ImageAsset[]) => void;
} {
  const [registry, setRegistry] = useState<Registry>(EMPTY);
  const unknown = (imageIds ?? []).some((id) => !registry.images.some((image) => image.id === id));
  useEffect(() => {
    if (!unknown) return;
    const controller = new AbortController();
    api.images({ signal: controller.signal }).then(
      ({ images, missing }) => setRegistry({ images, missing: new Set(missing) }),
      () => undefined,
    );
    return () => controller.abort();
  }, [unknown]);
  const add = useCallback((images: readonly ImageAsset[]) => {
    setRegistry((previous) => {
      const ids = new Set(images.map((image) => image.id));
      return {
        images: [...previous.images.filter((image) => !ids.has(image.id)), ...images],
        missing: new Set([...previous.missing].filter((id) => !ids.has(id))),
      };
    });
  }, []);
  const key = (imageIds ?? []).join('|');
  const images = useMemo(
    () => (key ? key.split('|') : []).flatMap((id) => registry.images.find((image) => image.id === id) ?? []),
    [key, registry],
  );
  return { images, missing: registry.missing, add };
}
