import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { AutoCorrection } from '../shared/auto-adjust.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { VideoLayer } from '../shared/model.js';
import type { TimelineLayout } from '../shared/timeline.js';
import {
  analyseClip,
  animatedSettings,
  autoAdjustCommand,
  autoAdjustTarget,
  cachedAnalysis,
  rememberAnalysis,
  settingLabel,
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

/** Track → Colour → Auto: analyses the clip at the playhead and applies its correction to the track. */
export function AutoAdjust({ projectId, layer, layout, assets, frame, selectedClipId, disabled, onEdit }: Props) {
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
      target={availability.target}
      onEdit={onEdit}
    />
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'analysing'; done: number; total: number }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; correction: AutoCorrection };

function AutoAdjustPopover({
  projectId,
  layer,
  target,
  onEdit,
}: Readonly<{
  projectId: string;
  layer: VideoLayer;
  target: AutoAdjustTarget;
  onEdit: (commands: readonly EditCommand[]) => void;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Intensity in percent; `draft` is the value being dragged, previewed but not chosen yet.
  const [percent, setPercent] = useState(100);
  const [draft, setDraft] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const controller = useRef<AbortController | null>(null);
  const stop = (): void => {
    controller.current?.abort();
    controller.current = null;
  };
  useEffect(() => () => controller.current?.abort(), []);

  const ready = phase.kind === 'ready' ? phase : null;
  const previewing = open && ready !== null;
  const shown = ready && autoAdjustCommand(layer, ready.correction, (draft ?? percent) / 100);
  // Re-issued when the committed track changes too, since that replaces the preview.
  useEffect(() => {
    if (previewing && ready) livePreview(autoAdjustCommand(layer, ready.correction, (draft ?? percent) / 100));
  }, [previewing, ready, layer, draft, percent]);
  useEffect(() => (previewing ? () => livePreview(null) : undefined), [previewing]);

  const analyse = async (): Promise<void> => {
    const cached = cachedAnalysis(projectId, target);
    if (cached) {
      setPercent(cached.percent);
      setPhase({ kind: 'ready', correction: cached.correction });
      return;
    }
    const abort = new AbortController();
    stop();
    controller.current = abort;
    setPhase({ kind: 'analysing', done: 0, total: target.sourceFrames.length });
    try {
      const correction = await analyseClip(target, abort.signal, (done, total) => {
        if (!abort.signal.aborted) setPhase({ kind: 'analysing', done, total });
      });
      abort.signal.throwIfAborted();
      rememberAnalysis(projectId, target, { key: target.key, correction, percent: 100 });
      setPercent(100);
      setPhase({ kind: 'ready', correction });
      setAnnouncement('Auto adjust is ready: its correction is previewed. Choose an Intensity, then Apply.');
    } catch (cause) {
      if (!abort.signal.aborted)
        setPhase({ kind: 'failed', message: cause instanceof Error ? cause.message : 'Auto adjust failed.' });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  };

  const openChange = (next: boolean): void => {
    setOpen(next);
    setDraft(null);
    if (next) {
      setAnnouncement('');
      void analyse();
    } else {
      stop();
      setPhase({ kind: 'idle' });
    }
  };

  const apply = (close: () => void): void => {
    if (!ready) return;
    const edit = autoAdjustCommand(layer, ready.correction, percent / 100);
    if (!edit) return;
    rememberAnalysis(projectId, target, { key: target.key, correction: ready.correction, percent });
    onEdit([edit]);
    close();
    setAnnouncement(`Auto adjust applied at ${percent}%.`);
  };

  const animated = animatedSettings(layer);
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
              <p className="auto-adjust-source" title={target.asset.name}>
                From {shortName(target.asset.name)}
              </p>
              {phase.kind === 'analysing' && (
                <output className="auto-adjust-progress">
                  Analysing {phase.done}/{phase.total} frames…
                </output>
              )}
              {phase.kind === 'failed' && (
                <p className="auto-adjust-error" role="alert">
                  {phase.message}
                </p>
              )}
              {ready && (
                <>
                  <div className="colour-control auto-adjust-intensity">
                    <span>
                      <ResetLabel
                        htmlFor={id}
                        name="intensity"
                        blocked={percent === 100 ? 'Already at its default value.' : null}
                        onReset={() => setPercent(100)}
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
                      How much of the suggested correction to apply: 100% applies all of it.
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
                    aria-disabled={shown === null || undefined}
                    title={shown === null ? 'Every setting Auto sets is animated on this track.' : undefined}
                    onClick={() => apply(close)}
                  >
                    Apply
                  </button>
                )}
                <button type="button" className="secondary-button small" onClick={close}>
                  {phase.kind === 'failed' ? 'Close' : 'Cancel'}
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
