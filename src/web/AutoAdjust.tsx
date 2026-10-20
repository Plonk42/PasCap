import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { AUTO_ADJUST, type AutoCorrection } from '../shared/auto-adjust.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { VideoLayer } from '../shared/model.js';
import type { TimelineLayout } from '../shared/timeline.js';
import {
  analyseClip,
  animatedSettings,
  autoAdjustCommands,
  autoAdjustTarget,
  cachedAnalysis,
  initialMode,
  rememberAnalysis,
  settingLabel,
  type AutoAdjustAvailability,
  type AutoAdjustMode,
  type AutoAdjustTarget,
} from './auto-adjust.js';
import { shortName } from './display.js';
import { Icon } from './icons.js';
import { livePreview } from './live-preview.js';
import { Popover } from './Popover.js';
import { ResetLabel } from './SettingValueControl.js';
import { ValueControl } from './ValueControl.js';
import './auto-adjust.css';

interface Props {
  projectId: string;
  layer: VideoLayer;
  layout: TimelineLayout;
  assets: readonly MediaAsset[];
  frame: number;
  selectedClipId: string | null;
  disabled: boolean;
  onEdit: (commands: readonly EditCommand[]) => void;
}

const TITLE = 'Analyse the clip at the playhead and suggest a balanced Colour correction for this track';
/** The initial Intensity, in percent: the correction as suggested. */
const BALANCED = Math.round(AUTO_ADJUST.balancedIntensity * 100);
const MODES: readonly { mode: AutoAdjustMode; label: string; hint: string }[] = [
  { mode: 'track', label: 'Track values', hint: 'whole clip' },
  { mode: 'playhead', label: 'Track values from playhead', hint: '1 s around it' },
  { mode: 'keyframe', label: 'Keyframe at playhead', hint: '1 s around it' },
];

/** Track → Colour → Auto: analyses the clip at the playhead and applies its correction to the track. */
export function AutoAdjust({
  projectId,
  layer,
  layout,
  assets,
  frame,
  selectedClipId,
  disabled,
  onEdit,
}: Readonly<Props>) {
  const hintId = useId();
  const availability = autoAdjustTarget(layer, layout, assets, frame, selectedClipId);
  const blocked = disabled ? 'Colour cannot be edited right now.' : availability.reason;
  if (blocked !== null || !availability.target)
    return (
      <span className="auto-adjust">
        <button
          type="button"
          className="auto-adjust-trigger"
          aria-label="Auto adjust"
          aria-disabled="true"
          aria-describedby={hintId}
          title={blocked ?? undefined}
        >
          <Icon name="wand" size={13} />
          Auto
        </button>
        <span id={hintId} className="sr-only">
          {blocked}
        </span>
      </span>
    );
  // A new clip, range or track is a new analysis: remounting cancels the old one and its preview.
  return (
    <AutoAdjustPopover
      key={`${projectId}:${layer.id}:${availability.target.key}`}
      projectId={projectId}
      layer={layer}
      trackTarget={availability.target}
      playheadAvailability={autoAdjustTarget(layer, layout, assets, frame, selectedClipId, 'playhead')}
      keyframeAvailability={autoAdjustTarget(layer, layout, assets, frame, selectedClipId, 'keyframe')}
      onEdit={onEdit}
    />
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'analysing'; key: string; done: number; total: number }
  | { kind: 'failed'; key: string; message: string }
  | { kind: 'ready'; key: string; correction: AutoCorrection };

function AutoAdjustPopover({
  projectId,
  layer,
  trackTarget,
  playheadAvailability,
  keyframeAvailability,
  onEdit,
}: Readonly<{
  projectId: string;
  layer: VideoLayer;
  trackTarget: AutoAdjustTarget;
  playheadAvailability: AutoAdjustAvailability;
  keyframeAvailability: AutoAdjustAvailability;
  onEdit: (commands: readonly EditCommand[]) => void;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AutoAdjustMode>('track');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Intensity in percent; `draft` is the value being dragged, previewed but not chosen yet.
  const [percent, setPercent] = useState(BALANCED);
  const [draft, setDraft] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const availabilities: Record<AutoAdjustMode, AutoAdjustAvailability> = {
    track: { target: trackTarget, reason: null },
    playhead: playheadAvailability,
    keyframe: keyframeAvailability,
  };
  const { target, reason } = availabilities[mode];
  const targetKey = target?.key ?? null;
  // A new mode or, for a keyframe, a new playhead is a new analysis; leaving it cancels the old one.
  useEffect(() => {
    if (!open || !target) return;
    const { key } = target;
    const cached = cachedAnalysis(projectId, target);
    if (cached) {
      setPercent(cached.percent);
      setPhase({ kind: 'ready', key, correction: cached.correction });
      return;
    }
    const abort = new AbortController();
    setPercent(BALANCED);
    setPhase({ kind: 'analysing', key, done: 0, total: target.sourceFrames.length });
    analyseClip(target, abort.signal, (done, total) => {
      if (!abort.signal.aborted) setPhase({ kind: 'analysing', key, done, total });
    }).then(
      (correction) => {
        if (abort.signal.aborted) return;
        rememberAnalysis(projectId, target, { correction, percent: BALANCED });
        setPhase({ kind: 'ready', key, correction });
        setAnnouncement('Auto adjust is ready: its correction is previewed. Choose an Intensity, then Apply.');
      },
      (cause: unknown) => {
        if (!abort.signal.aborted)
          setPhase({ kind: 'failed', key, message: cause instanceof Error ? cause.message : 'Auto adjust failed.' });
      },
    );
    return () => abort.abort();
    // The key identifies the target: a new object for the same frames is the same analysis.
  }, [open, projectId, targetKey]);

  const current = phase.kind !== 'idle' && phase.key === targetKey ? phase : null;
  const ready = current?.kind === 'ready' && target ? { correction: current.correction, target } : null;
  const correction = current?.kind === 'ready' ? current.correction : null;
  const commandsAt = (value: number): EditCommand[] =>
    ready ? autoAdjustCommands(layer, ready.target, ready.correction, value / 100) : [];
  const previewing = open && ready !== null;
  // Re-issued when the committed track changes too, since that replaces the preview, and on a new mode for
  // the same analysis.
  useEffect(() => {
    if (previewing && target && correction)
      livePreview(autoAdjustCommands(layer, target, correction, (draft ?? percent) / 100));
  }, [previewing, targetKey, mode, correction, layer, draft, percent]);
  useEffect(() => (previewing ? () => livePreview(null) : undefined), [previewing]);

  const openChange = (next: boolean): void => {
    setOpen(next);
    setDraft(null);
    if (next) {
      setAnnouncement('');
      setMode(initialMode(layer));
    } else setPhase({ kind: 'idle' });
  };

  const apply = (close: () => void): void => {
    if (!ready) return;
    const commands = commandsAt(percent);
    if (!commands.length) return;
    rememberAnalysis(projectId, ready.target, { correction: ready.correction, percent });
    onEdit(commands);
    close();
    setAnnouncement(
      mode === 'keyframe' ? `Auto adjust keyframed at ${percent}%.` : `Auto adjust applied at ${percent}%.`,
    );
  };

  const animated = mode === 'keyframe' ? [] : animatedSettings(layer);
  const nothing = ready !== null && commandsAt(percent).length === 0;
  return (
    <span className="auto-adjust">
      <Popover
        label="Auto adjust"
        title={TITLE}
        className="auto-adjust-popover"
        trigger={
          <>
            <Icon name="wand" size={13} />
            Auto
          </>
        }
        onOpenChange={openChange}
      >
        {(close) => {
          // Escape cancels Auto from anywhere inside, after a slider drag has had its own Escape.
          const escape = (event: KeyboardEvent<HTMLDivElement>): void => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            close();
          };
          return (
            <div className="auto-adjust-panel" onKeyDownCapture={escape}>
              <p className="auto-adjust-source" title={trackTarget.asset.name}>
                From {shortName(trackTarget.asset.name)}
              </p>
              <fieldset className="auto-adjust-mode">
                <legend>Apply to</legend>
                {MODES.map((option) => (
                  <label key={option.mode}>
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      aria-label={option.label}
                      checked={mode === option.mode}
                      onChange={() => {
                        setDraft(null);
                        setMode(option.mode);
                      }}
                    />
                    <span>
                      {option.label}
                      <small>{option.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {reason !== null && <p className="auto-adjust-error">{reason}</p>}
              {current?.kind === 'analysing' && (
                <output className="auto-adjust-progress">
                  Analysing {current.done}/{current.total} frames…
                </output>
              )}
              {current?.kind === 'failed' && (
                <p className="auto-adjust-error" role="alert">
                  {current.message}
                </p>
              )}
              {ready && (
                <>
                  <div className="colour-control auto-adjust-intensity">
                    <span>
                      <ResetLabel
                        htmlFor={id}
                        name="intensity"
                        blocked={percent === BALANCED ? 'Already at its default value.' : null}
                        onReset={() => setPercent(BALANCED)}
                      >
                        Intensity
                      </ResetLabel>
                    </span>
                    <ValueControl
                      id={id}
                      aria-label="Auto adjust intensity"
                      aria-describedby={`${id}-hint`}
                      min={0}
                      max={100}
                      step={1}
                      unit="%"
                      value={percent}
                      onCommit={setPercent}
                      onDraft={setDraft}
                    />
                    <span id={`${id}-hint`} className="sr-only">
                      How much of the suggested correction to apply: {BALANCED}% applies it as suggested, more
                      exaggerates it.
                    </span>
                  </div>
                  {animated.length > 0 && (
                    <ul className="auto-adjust-animated">
                      {animated.map((setting) => (
                        <li key={setting}>{settingLabel(setting)} is animated: not changed</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <div className="auto-adjust-actions">
                {ready && (
                  <button
                    type="button"
                    className="primary-button small"
                    aria-disabled={nothing || undefined}
                    title={
                      nothing ? 'Every setting Auto sets is animated on this track: add a keyframe instead.' : undefined
                    }
                    onClick={() => apply(close)}
                  >
                    Apply
                  </button>
                )}
                <button type="button" className="secondary-button small" onClick={close}>
                  {current?.kind === 'failed' ? 'Close' : 'Cancel'}
                </button>
              </div>
            </div>
          );
        }}
      </Popover>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </span>
  );
}
