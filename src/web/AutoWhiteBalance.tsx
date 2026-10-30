import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { whiteBalanceCommands } from '../shared/auto-color.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import type { TimelineLayout } from '../shared/timeline.js';
import { frameIlluminant, poolWhiteBalance } from '../shared/white-balance.js';
import { proxyUrl } from './api.js';
import { whiteBalanceTarget } from './auto-white-balance.js';
import { gradeOwnerOf } from './color-owner.js';
import { Icon } from './icons.js';
import { useDelayedFlag } from './use-delayed-flag.js';
import './auto-white-balance.css';

interface Props {
  project: ProjectDocument;
  /** The clip whose grade takes the keyframe. */
  clipId: string;
  layout: TimelineLayout;
  assets: readonly MediaAsset[];
  playhead: number;
  disabled: boolean;
  onEdit: (commands: readonly EditCommand[]) => void;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Estimates the light of a few frames around the playhead and keyframes Temperature and Tint of the clip's grade at
 * the source frame shown there, like their diamonds. Moving the playhead, changing clip or project, or leaving cancels
 * it.
 */
export function AutoWhiteBalance({ project, clipId, layout, assets, playhead, disabled, onEdit }: Readonly<Props>) {
  const hintId = useId();
  const availability = whiteBalanceTarget(project, clipId, layout, assets, playhead);
  const { target } = availability;
  const context = target
    ? [
        project.id,
        playhead,
        target.clip.clip.id,
        target.asset.prepared?.verification.verifiedAt,
        ...target.sourceFrames,
      ].join(':')
    : '';
  const [progress, setProgress] = useState<{ context: string; done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<{ context: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ project, disabled });
  latest.current = { project, disabled };
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [context],
  );
  const running = progress !== null && progress.context === context;
  const showProgress = useDelayedFlag(running);
  let blocked: string | null = availability.reason;
  if (disabled) blocked = 'Color cannot be edited right now.';
  else if (running) blocked = 'Analyzing the light around the playhead…';

  const start = async (): Promise<void> => {
    if (blocked !== null || !target) return;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setFailure(null);
    setAnnouncement('');
    setProgress({ context, done: 0, total: new Set(target.sourceFrames).size });
    try {
      const { sampleProxyFrames } = await import('../preview/frame-sampler.js');
      const sampled = await sampleProxyFrames(
        proxyUrl(target.asset.id),
        target.sourceFrames,
        abort.signal,
        (done, total) => {
          if (!abort.signal.aborted) setProgress({ context, done, total });
        },
      );
      abort.signal.throwIfAborted();
      const estimates = new Map([...sampled].map(([source, pixels]) => [source, frameIlluminant(pixels)]));
      const balance = poolWhiteBalance(target.sourceFrames.map((source) => estimates.get(source) ?? null));
      if (!balance) throw new Error('These frames are too dark, too bright or too uniform to estimate their light.');
      const owner = gradeOwnerOf(latest.current.project, clipId);
      if (latest.current.disabled || !owner) throw new Error('Color cannot be edited right now. Try again.');
      onEdit(whiteBalanceCommands(owner, target.frame, balance, { kind: 'clip', clipId }));
      setAnnouncement(
        `White balance keyframed at source frame ${target.frame}: Temperature ${signed(balance.temperature)}, Tint ${signed(balance.tint)}.`,
      );
    } catch (cause) {
      if (!abort.signal.aborted)
        setFailure({ context, message: cause instanceof Error ? cause.message : 'Automatic white balance failed.' });
    } finally {
      if (controller.current === abort) controller.current = null;
      setProgress((current) => (current?.context === context ? null : current));
    }
  };

  const cancel = (): void => {
    controller.current?.abort();
    controller.current = null;
    setProgress(null);
  };
  // Escape cancels a running analysis without reaching editor shortcuts.
  const escape = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Escape' || !running) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  return (
    <div className="auto-white-balance">
      <button
        type="button"
        className="secondary-button small auto-white-balance-button"
        aria-disabled={blocked !== null || undefined}
        aria-describedby={hintId}
        title={blocked ?? 'Estimate the light around the playhead and keyframe this clip’s Temperature and Tint here'}
        onClick={() => void start()}
        onKeyDown={escape}
      >
        <Icon name="wand" size={13} />
        Auto white balance
      </button>
      {running && showProgress && (
        <span className="auto-white-balance-status">
          <output className="auto-white-balance-progress">
            Analyzing {progress.done}/{progress.total}…
          </output>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel automatic white balance"
            title="Cancel"
            onClick={cancel}
            onKeyDown={escape}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      )}
      <span id={hintId} className="sr-only">
        {blocked ??
          'Analyses a few frames of this clip around the playhead and adds Temperature and Tint keyframes to its grade at the playhead.'}
      </span>
      {failure?.context === context && (
        <p className="auto-white-balance-error" role="alert">
          {failure.message}
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
