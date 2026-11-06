import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { Icon } from './icons.js';
import { livePreview } from './live-preview.js';

/** Commands showing the project without one setting, previewed only while its eye is held. */
export type BypassPreview = EditCommand | readonly EditCommand[];

let bypassed: string | null = null;
const listeners = new Set<() => void>();
function publish(name: string | null): void {
  bypassed = name;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The name of the setting whose eye is held, for the preview badge. */
export function useBypassedSetting(): string | null {
  return useSyncExternalStore(subscribe, () => bypassed);
}

/**
 * Hold to preview the image without one setting; release, pointer cancel, lost capture or window blur
 * restore it. Preview only: the project, history and saving never change. `preview` is null when the
 * setting is already neutral at every frame.
 */
export function BypassButton({ name, preview }: Readonly<{ name: string; preview: BypassPreview | null }>) {
  const [held, setHeld] = useState(false);
  const holding = useRef(false);
  const release = useRef(() => {
    if (!holding.current) return;
    holding.current = false;
    livePreview(null);
    publish(null);
    setHeld(false);
  }).current;
  useEffect(() => {
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('blur', release);
      release();
    };
  }, [release]);
  const press = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || !preview) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    holding.current = true;
    livePreview(preview);
    publish(name);
    setHeld(true);
  };
  return (
    <button
      type="button"
      className="setting-bypass"
      aria-label={`Hold to compare without ${name}`}
      aria-pressed={held}
      aria-disabled={!preview}
      tabIndex={-1}
      title={preview ? `Hold to see the preview without ${name}` : `${name} is neutral: nothing to compare`}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <Icon name={held ? 'eye-off' : 'eye'} size={11} />
    </button>
  );
}
