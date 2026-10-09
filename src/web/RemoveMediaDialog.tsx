import { useId } from 'react';
import { Modal } from './Modal.js';

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** Confirms removing recordings that still have timeline excerpts or music tracks. */
export function RemoveMediaDialog({
  names,
  clips,
  music,
  busy,
  onCancel,
  onConfirm,
}: Readonly<{
  names: readonly string[];
  clips: number;
  music: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const id = useId();
  const subject = names.length === 1 ? names[0]! : count(names.length, 'recording', 'recordings');
  const usage = [
    clips > 0 && count(clips, 'timeline clip', 'timeline clips'),
    music > 0 && count(music, 'music track', 'music tracks'),
  ]
    .filter(Boolean)
    .join(' and ');
  return (
    <Modal
      className="remove-media-dialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-help`}
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy} onClick={onConfirm}>
            Remove from project
          </button>
        </>
      }
    >
      <h2 id={`${id}-title`}>Remove {subject} from this project?</h2>
      <p id={`${id}-help`}>
        {usage} using {names.length === 1 ? 'it' : 'them'} will be removed too. Undo restores everything. Original
        recordings, prepared media and exported videos are kept.
      </p>
    </Modal>
  );
}
