import { useState } from 'react';
import { addClipSpeedKey, editableClipSpeed, editClipSpeedRate, removeClipSpeedKey } from '../shared/clip-speed.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { MAX_CLIP_SPEED_KEYS, sourceRateAt, type SpeedSettings } from '../shared/speed.js';
import { KeyframeLine } from './AnimationControls.js';
import { previewClipSource } from './clip-speed-geometry.js';
import { ClipSpeedCurve } from './ClipSpeedCurve.js';
import './declutter.css';
import { sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { useKeyframeNavigation } from './keyframe-navigation.js';
import './keyframe-navigation.css';
import './layer-keyframes.css';
import { LockedCue, RateValueControl, ResetLabel, resetBlocked } from './SettingValueControl.js';
import {
  inspectSpatialKeyframe,
  reconcileSpatialInspection,
  speedFrames,
  type SpatialInspection,
} from './spatial-navigation.js';
import type { DraftPreview } from './Timeline.js';

export interface SpeedControlsProps {
  project: ProjectDocument;
  clip: VideoClip | null;
  frame: number;
  placedDuration: number | null;
  /** Actually displayed source frame of the selected clip, or null outside it. */
  sourceFrame: number | null;
  sourceFrameCount: number | null;
  disabled: boolean;
  helpId: string;
  onEdit: (command: EditCommand) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
  /** Project/editing context; the clip identity is added locally. */
  resetKey?: string | number;
}

export function SpeedHelp({ helpId }: Readonly<{ helpId: string }>) {
  return (
    <HelpPopover label="Speed timing" guide="precise-clip-speed-curves">
      <p id={helpId}>
        1× is recorded speed: below 1× is slow motion, above is faster. A keyframe ◇ changes the speed over the length
        of this clip.
      </p>
      <p className="editor-help-tip">Tip: presets such as Ramp up replace this clip’s speed keyframes.</p>
    </HelpPopover>
  );
}

function SpeedRate({
  clip,
  sourceFrame,
  disabled,
  helpId,
  inputContext,
  change,
  validate,
}: Readonly<{
  clip: VideoClip;
  sourceFrame: number | null;
  disabled: boolean;
  helpId: string;
  inputContext: string;
  change: (speed: SpeedSettings, seekSource?: number) => void;
  validate: (speed: SpeedSettings) => string | null;
}>) {
  const speed = clip.speed;
  const keys = speed.mode === 'curve' ? speed.keyframes : [];
  const active = sourceFrame !== null && keys.some((key) => key.frame === sourceFrame);
  const locked = speed.mode === 'curve' && !active;
  const rate = sourceRateAt(speed, sourceFrame ?? clip.sourceIn);
  const rateId = `${helpId}-rate`;
  const captureDisabled = disabled || sourceFrame === null || (!active && keys.length >= MAX_CLIP_SPEED_KEYS);
  const edit = (next: number): SpeedSettings => editClipSpeedRate(speed, sourceFrame, next);
  return (
    <div
      className="colour-control layer-keyed-control speed-rate-control"
      data-animated={speed.mode === 'curve'}
      data-key-at-playhead={active}
    >
      <span>
        <ResetLabel
          htmlFor={rateId}
          title="Double-click to reset Speed to 1×"
          name="Speed"
          blocked={resetBlocked(rate === 1, disabled, locked)}
          onReset={() => change(edit(1), sourceFrame ?? undefined)}
        >
          Speed ×
        </ResetLabel>
        {locked && <LockedCue />}
        <span className="colour-control-actions">
          <span className="keyframe-setting-navigation" data-animated={speed.mode === 'curve'}>
            <button
              type="button"
              className={`keyframe-toggle speed-keyframe-toggle${active ? ' active' : ''}`}
              aria-label="Keyframe Speed"
              aria-pressed={active}
              title={
                active
                  ? 'Remove the Speed keyframe at the displayed source frame. Removing the last one keeps its rate as constant speed.'
                  : 'Keyframe Speed at the displayed source frame. Capture the displayed rate for this clip.'
              }
              disabled={captureDisabled}
              onClick={() => {
                if (sourceFrame === null) return;
                if (active && speed.mode === 'curve') change(removeClipSpeedKey(speed, sourceFrame));
                else change(addClipSpeedKey(speed, sourceFrame), sourceFrame);
              }}
            >
              <span aria-hidden="true">{active ? '◆' : '◇'}</span>
            </button>
          </span>
        </span>
      </span>
      <RateValueControl
        id={rateId}
        aria-label="Clip speed rate"
        aria-describedby={helpId}
        // A read-only interpolated rate is shown to 0.001×; keyed and constant rates keep full precision.
        value={locked ? Math.round(rate * 1000) / 1000 : rate}
        disabled={disabled || locked}
        resetKey={`${inputContext}:${speed.mode === 'curve' ? sourceFrame : 'constant'}`}
        validate={(next) => {
          try {
            return validate(edit(next));
          } catch (cause) {
            return cause instanceof Error ? cause.message : 'This speed is invalid.';
          }
        }}
        onCommit={(next) => change(edit(next), speed.mode === 'curve' ? (sourceFrame ?? undefined) : undefined)}
      />
    </div>
  );
}

export function SpeedControls({
  project,
  clip,
  frame,
  placedDuration,
  disabled,
  helpId,
  onEdit,
  onPreview,
  onSeek,
  onPause,
  sourceFrame,
  sourceFrameCount,
  resetKey,
}: Readonly<SpeedControlsProps>) {
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const inputContext = `${resetKey ?? project.id}:${clip?.id ?? 'none'}`;
  const [selection, setSelection] = useState<SpatialInspection | null>(null);
  const context = `${project.id}:${clip?.id}:${navigation.sourceEpoch ?? 0}:speed`;
  const inspection = reconcileSpatialInspection(
    selection,
    context,
    project,
    clip,
    frame,
    (navigation.playing ?? false) || navigation.inspection !== null,
    speedFrames,
  );
  if (inspection !== selection) setSelection(inspection);
  const keys = clip?.speed.mode === 'curve' ? clip.speed.keyframes : [];
  const cursor = inspection?.frame ?? sourceFrame ?? clip?.sourceIn ?? 0;
  const previous = [...keys].reverse().find((key) => key.frame < cursor);
  const next = keys.find((key) => key.frame > cursor);
  const [error, setError] = useState('');
  const validate = (speed: SpeedSettings): string | null => {
    if (!clip) return 'Select a clip to edit its speed.';
    try {
      applyCommand(project, { type: 'speed', clipId: clip.id, speed });
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'This speed conflicts with the timeline.';
    }
  };
  /** A keyframe edit retimes the clip; follow the edited keyframe rather than keep a stale project frame. */
  const change = (speed: SpeedSettings, seekSource?: number): void => {
    if (!clip || unavailable) return;
    const command: EditCommand = { type: 'speed', clipId: clip.id, speed };
    try {
      const document = applyCommand(project, command);
      onEdit(command);
      setError('');
      if (seekSource !== undefined) onSeek(previewClipSource(document, clip.id, seekSource));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This speed conflicts with the timeline.');
    }
  };
  const selectStored = (sourceKey: number): SpatialInspection | null => {
    if (unavailable) return null;
    const selected = inspectSpatialKeyframe(context, project, clip, sourceKey, frame, speedFrames);
    if (!selected) return null;
    navigation.onFollowPlayhead();
    setSelection(selected);
    return selected;
  };
  const seek = (key: { frame: number } | undefined): void => {
    if (!key) return;
    const selected = selectStored(key.frame);
    if (selected) (navigation.onSeekSourceKeyframe ?? onSeek)(selected.expectedFrame);
  };
  const speed = clip?.speed;
  const rate = clip && speed ? sourceRateAt(speed, sourceFrame ?? clip.sourceIn) : 1;
  const modified = !!speed && (speed.mode === 'curve' || speed.rate !== 1);

  return (
    <InspectorSection
      id="speed"
      title="Speed"
      icon="speed"
      badge={`${rate.toFixed(2)}×`}
      modified={modified}
      help={<SpeedHelp helpId={helpId} />}
    >
      {clip && speed ? (
        <section className="speed-settings declutter-speed" aria-label="Clip speed">
          <KeyframeLine
            label="Speed"
            count={keys.length}
            disabled={unavailable}
            previous={!!previous}
            next={!!next}
            onPrevious={() => seek(previous)}
            onNext={() => seek(next)}
          >
            <button
              type="button"
              className="text-button"
              aria-label="Reset speed to 1×"
              title="Reset this clip to constant 1×. Its speed keyframes are removed."
              disabled={unavailable || !modified}
              onClick={() => change({ mode: 'constant', rate: 1 })}
            >
              <Icon name="reset" size={12} />
              Reset
            </button>
          </KeyframeLine>
          {placedDuration !== null && placedDuration !== clip.sourceOut - clip.sourceIn && (
            <div className="speed-overview">
              <span>
                {sourceSeconds(clip.sourceOut - clip.sourceIn)} <Icon name="arrow" size={12} />{' '}
                {sourceSeconds(placedDuration)}
              </span>
            </div>
          )}
          <select
            aria-label="Speed mode"
            disabled={unavailable}
            value={speed.mode}
            onChange={(event) =>
              change(event.target.value === 'curve' ? editableClipSpeed(clip) : { mode: 'constant', rate: 1 })
            }
          >
            <option value="constant">Constant speed</option>
            <option value="curve">Custom curve</option>
          </select>
          {speed.mode === 'constant' && (
            <div className="speed-presets">
              {[0.25, 0.5, 1, 2, 4].map((preset) => (
                <button
                  type="button"
                  key={preset}
                  className={`text-button ${speed.rate === preset ? 'active' : ''}`}
                  disabled={unavailable}
                  onClick={() => change({ mode: 'constant', rate: preset })}
                >
                  {preset}×
                </button>
              ))}
            </div>
          )}
          <SpeedRate
            clip={clip}
            sourceFrame={sourceFrame}
            disabled={unavailable}
            helpId={helpId}
            inputContext={inputContext}
            change={change}
            validate={validate}
          />
          {error && (
            <p className="control-hint" role="alert">
              {error}
            </p>
          )}
          {speed.mode === 'curve' && sourceFrameCount !== null && (
            <ClipSpeedCurve
              key={`${project.id}:${clip.id}`}
              project={project}
              clip={clip}
              speed={speed}
              sourceFrameCount={sourceFrameCount}
              frame={frame}
              sourceFrame={sourceFrame}
              disabled={disabled}
              onEdit={onEdit}
              onPreview={onPreview}
              onSeek={navigation.onSeekSourceKeyframe ?? onSeek}
              onPause={onPause}
              inspectedFrame={inspection?.frame ?? null}
              onSelectStored={(sourceKey) => {
                selectStored(sourceKey);
              }}
            />
          )}
        </section>
      ) : (
        <p className="control-hint">Select a clip to edit its speed.</p>
      )}
    </InspectorSection>
  );
}
