import { useId, useLayoutEffect, useRef, useState } from 'react';
import { formatTimecode } from '../shared/timing.js';

/** Non-drop-frame display uses 30 nominal frames, not rounded wall-clock seconds. */
export function parseTimecode(text: string, duration: number): { frame: number } | { error: string } {
  const value = text.trim();
  const match = /^(\d{1,3}):(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  let frame: number;
  if (/^\d+$/.test(value)) frame = Number(value);
  else if (match && Number(match[2]) < 60 && Number(match[3]) < 60 && Number(match[4]) < 30) {
    frame = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 30 + Number(match[4]);
  } else return { error: 'Use HH:MM:SS:FF (30 fps NDF), or a whole timeline frame.' };
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= duration)
    return { error: `Choose frame 0–${Math.max(0, duration - 1)}, inside the timeline.` };
  return { frame };
}
export function TimecodeField({
  frame,
  duration,
  disabled,
  onSeek,
}: Readonly<{ frame: number; duration: number; disabled: boolean; onSeek: (frame: number) => void }>) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const editingActive = useRef(false);
  const focusRequest = useRef<'input' | 'button' | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const requested = focusRequest.current;
    focusRequest.current = null;
    if (requested === 'input') input.current?.focus({ preventScroll: true });
    if (requested === 'button') button.current?.focus({ preventScroll: true });
  }, [editing]);
  const commit = (returnFocus: boolean): void => {
    if (!editingActive.current || disabled) return;
    const result = parseTimecode(draft, duration);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    // End this session before unmounting or restoring focus can emit blur.
    editingActive.current = false;
    focusRequest.current = returnFocus ? 'button' : null;
    setEditing(false);
    setError('');
    onSeek(result.frame);
  };
  return (
    <div className="timecode-editor">
      {editing ? (
        <input
          ref={input}
          aria-label="Playhead timecode"
          type="text"
          value={draft}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? id : undefined}
          data-dirty={draft !== formatTimecode(frame)}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
          }}
          onBlur={() => commit(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              commit(true);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              editingActive.current = false;
              focusRequest.current = 'button';
              setEditing(false);
              setError('');
            }
          }}
        />
      ) : (
        <button
          ref={button}
          className="timecode-value"
          aria-label="Go to timecode"
          title="Go to HH:MM:SS:FF or timeline frame"
          disabled={disabled || !duration}
          onClick={() => {
            editingActive.current = true;
            focusRequest.current = 'input';
            setDraft(formatTimecode(frame));
            setError('');
            setEditing(true);
          }}
        >
          {formatTimecode(frame)}
        </button>
      )}
      {error && (
        <span id={id} className="timecode-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
