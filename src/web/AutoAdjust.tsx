import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { AUTO_ADJUST, type AutoCorrection } from '../shared/auto-adjust.js';
import { animatedSettings } from '../shared/auto-colour.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { VideoLayer } from '../shared/model.js';
import type { TimelineLayout } from '../shared/timeline.js';
import {
  analyseTarget,
  autoAdjustCommands,
  autoAdjustTarget,
  cachedAnalysis,
  initialChoice,
  keyframeReason,
  rememberAnalysis,
  settingLabel,
  type AutoAdjustApply,
  type AutoAdjustAvailability,
  type AutoAdjustSource,
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
const SOURCES: readonly { source: AutoAdjustSource; label: string; hint: string }[] = [
  { source: 'playhead', label: 'Playhead', hint: '1 s around it' },
  { source: 'clip', label: 'Clip', hint: 'all of it' },
  { source: 'track', label: 'Track', hint: 'all its clips' },
];
const APPLIES: readonly { apply: AutoAdjustApply; label: string; name: string; hint: string }[] = [
  { apply: 'values', label: 'Track values', name: 'Track values', hint: 'whole track' },
  { apply: 'keyframe', label: 'Keyframe', name: 'Keyframe at playhead', hint: 'at playhead' },
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
      availabilities={{
        playhead: autoAdjustTarget(layer, layout, assets, frame, selectedClipId, 'playhead'),
        clip: availability,
        track: autoAdjustTarget(layer, layout, assets, frame, selectedClipId, 'track'),
      }}
      frame={frame}
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
  availabilities,
  frame,
  onEdit,
}: Readonly<{
  projectId: string;
  layer: VideoLayer;
  availabilities: Readonly<Record<AutoAdjustSource, AutoAdjustAvailability>>;
  frame: number;
  onEdit: (commands: readonly EditCommand[]) => void;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<AutoAdjustSource>('clip');
  const [applyAs, setApplyAs] = useState<AutoAdjustApply>('values');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Intensity in percent; `draft` is the value being dragged, previewed but not chosen yet.
  const [percent, setPercent] = useState(BALANCED);
  const [draft, setDraft] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const available = availabilities[source];
  const reason = available.reason ?? (applyAs === 'keyframe' ? keyframeReason(layer, source, frame) : null);
  const target: AutoAdjustTarget | null = reason === null ? available.target : null;
  const targetKey = target?.key ?? null;
  // A new source or, from the playhead, a new playhead is a new analysis; leaving it cancels the old one.
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
    const total = target.reads.reduce((sum, read) => sum + read.sourceFrames.length, 0);
    setPhase({ kind: 'analysing', key, done: 0, total });
    analyseTarget(target, abort.signal, (done) => {
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
    ready ? autoAdjustCommands(layer, applyAs, frame, ready.correction, value / 100) : [];
  const previewing = open && ready !== null;
  // Re-issued when the committed track changes too, since that replaces the preview, and on a new way to apply
  // the same analysis.
  useEffect(() => {
    if (previewing && correction)
      livePreview(autoAdjustCommands(layer, applyAs, frame, correction, (draft ?? percent) / 100));
  }, [previewing, targetKey, applyAs, frame, correction, layer, draft, percent]);
  useEffect(() => (previewing ? () => livePreview(null) : undefined), [previewing]);

  const openChange = (next: boolean): void => {
    setOpen(next);
    setDraft(null);
    if (next) {
      setAnnouncement('');
      const initial = initialChoice(layer);
      setSource(initial.source);
      setApplyAs(initial.apply);
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
      applyAs === 'keyframe' ? `Auto adjust keyframed at ${percent}%.` : `Auto adjust applied at ${percent}%.`,
    );
  };

  const animated = applyAs === 'keyframe' ? [] : animatedSettings(layer);
  const nothing = ready !== null && commandsAt(percent).length === 0;
  const analysed = available.target?.label ?? availabilities.clip.target?.label ?? '';
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
              <p className="auto-adjust-source" title={analysed}>
                From {shortName(analysed)}
              </p>
              <fieldset className="auto-adjust-mode">
                <legend>Source</legend>
                {SOURCES.map((option) => (
                  <label key={option.source}>
                    <input
                      type="radio"
                      name={`${id}-source`}
                      aria-label={option.label}
                      checked={source === option.source}
                      onChange={() => {
                        setDraft(null);
                        setSource(option.source);
                        // A keyframe takes the light at the playhead only.
                        if (option.source !== 'playhead') setApplyAs('values');
                      }}
                    />
                    <span>
                      {option.label}
                      <small>{option.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="auto-adjust-mode">
                <legend>Apply as</legend>
                {APPLIES.map((option) => {
                  const unavailable = option.apply === 'keyframe' && source !== 'playhead';
                  return (
                    <label key={option.apply} title={unavailable ? 'Analyse the playhead to key it.' : undefined}>
                      <input
                        type="radio"
                        name={`${id}-apply`}
                        aria-label={option.name}
                        checked={applyAs === option.apply}
                        disabled={unavailable}
                        onChange={() => {
                          setDraft(null);
                          setApplyAs(option.apply);
                        }}
                      />
                      <span>
                        {option.label}
                        <small>{unavailable ? 'needs Playhead' : option.hint}</small>
                      </span>
                    </label>
                  );
                })}
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
