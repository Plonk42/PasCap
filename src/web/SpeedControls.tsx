import { editableClipSpeed } from '../shared/clip-speed.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys } from '../shared/keyframes.js';
import type { ProjectDocument, VideoClip, VideoLayer } from '../shared/model.js';
import { sourceRateAt, type SpeedSettings } from '../shared/speed.js';
import { ClipSpeedCurve } from './ClipSpeedCurve.js';
import './declutter.css';
import { sourceSeconds } from './display.js';
import { EasingSelect } from './EasingSelect.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { settingPresentation } from './setting-scope.js';
import { RateValueControl, SpeedRateField } from './SettingValueControl.js';
import type { DraftPreview } from './Timeline.js';

export interface SpeedControlsProps {
  project: ProjectDocument;
  clip: VideoClip | null;
  layer: VideoLayer;
  frame: number;
  projectDuration: number;
  placedDuration: number | null;
  sourceFrame: number | null;
  sourceFrameCount: number | null;
  disabled: boolean;
  helpId: string;
  onEdit: (command: EditCommand) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
  /** Project/editing context; clip and layer identities are added locally. */
  resetKey?: string | number;
}

function speedPreset(speed: SpeedSettings): string {
  if (speed.mode === 'constant') return 'constant';
  if (speed.mode === 'curve') return 'curve';
  return speed.endRate >= speed.startRate ? 'ramp-up' : 'ramp-down';
}

/** Static clip bases are independent of the layer curve and never create endpoint keys. */
function BaseSpeedControls({
  clip,
  disabled,
  helpId,
  inputContext,
  onChange,
  validate,
}: Readonly<{
  clip: VideoClip;
  disabled: boolean;
  helpId: string;
  inputContext: string | number;
  onChange: (speed: SpeedSettings) => void;
  validate: (speed: SpeedSettings) => string | null;
}>) {
  const speed = clip.speed;
  return (
    <>
      <select
        aria-label="Speed mode"
        disabled={disabled}
        value={speedPreset(speed)}
        onChange={(event) => {
          if (event.target.value === 'constant') onChange({ mode: 'constant', rate: 1 });
          else if (event.target.value === 'curve') onChange(editableClipSpeed(clip));
          else
            onChange({
              mode: 'ramp',
              startRate: event.target.value === 'ramp-up' ? 0.5 : 2,
              endRate: event.target.value === 'ramp-up' ? 2 : 0.5,
              curve: 'smooth',
              anchorIn: clip.sourceIn,
              anchorOut: clip.sourceOut,
            });
        }}
      >
        <option value="constant">Constant speed</option>
        <option value="ramp-up">Ramp up</option>
        <option value="ramp-down">Ramp down</option>
        <option value="curve">Custom curve</option>
      </select>
      {speed.mode === 'constant' && (
        <>
          <div className="speed-presets">
            {[0.25, 0.5, 1, 2, 4].map((rate) => (
              <button
                type="button"
                key={rate}
                className={`text-button ${speed.rate === rate ? 'active' : ''}`}
                disabled={disabled}
                onClick={() => onChange({ mode: 'constant', rate })}
              >
                {rate}×
              </button>
            ))}
          </div>
          <div className="speed-field">
            <label htmlFor={`${helpId}-constant-rate`}>Rate ×</label>
            <RateValueControl
              id={`${helpId}-constant-rate`}
              aria-label="Clip speed rate"
              aria-describedby={helpId}
              value={speed.rate}
              disabled={disabled}
              resetKey={inputContext}
              validate={(rate) => validate({ mode: 'constant', rate })}
              onCommit={(rate) => onChange({ mode: 'constant', rate })}
            />
          </div>
        </>
      )}
      {speed.mode === 'ramp' && (
        <>
          <div className="value-rate-fields">
            <div className="speed-field">
              <label htmlFor={`${helpId}-ramp-start`}>Start ×</label>
              <RateValueControl
                id={`${helpId}-ramp-start`}
                aria-label="Ramp start rate"
                disabled={disabled}
                value={speed.startRate}
                resetKey={`${inputContext}:${speed.anchorIn}:${speed.anchorOut}`}
                validate={(startRate) => validate({ ...speed, startRate })}
                onCommit={(startRate) => onChange({ ...speed, startRate })}
              />
            </div>
            <div className="speed-field">
              <label htmlFor={`${helpId}-ramp-end`}>End ×</label>
              <RateValueControl
                id={`${helpId}-ramp-end`}
                aria-label="Ramp end rate"
                disabled={disabled}
                value={speed.endRate}
                resetKey={`${inputContext}:${speed.anchorIn}:${speed.anchorOut}`}
                validate={(endRate) => validate({ ...speed, endRate })}
                onCommit={(endRate) => onChange({ ...speed, endRate })}
              />
            </div>
          </div>
          <label className="speed-field">
            Curve
            <EasingSelect
              aria-label="Ramp curve"
              value={speed.curve}
              disabled={disabled}
              allowHold={false}
              ramp
              onChange={(curve) => {
                if (curve !== 'hold') onChange({ ...speed, curve });
              }}
            />
          </label>
        </>
      )}
    </>
  );
}

function rowGraphFrames(layer: VideoLayer, projectDuration: number): number[] {
  const last = Math.max(0, projectDuration - 1);
  const frames = new Set(Array.from({ length: 33 }, (_, index) => (index / 32) * last));
  const keys = layer.keyframes.filter((key) => key.values.speed !== null);
  for (const [index, key] of keys.entries()) {
    if (key.frame > last) break;
    frames.add(key.frame);
    // Draw a held value right up to its jump, not a fictitious interpolated ramp.
    if (index > 0 && keys[index - 1]!.interpolation === 'hold' && key.frame > 0) frames.add(key.frame - 0.001);
  }
  return [...frames].sort((left, right) => left - right);
}

function speedGraphPoints(clip: VideoClip | null, layer: VideoLayer, projectDuration: number): string {
  if (hasLayerKeys(layer, 'speed')) {
    const last = Math.max(1, projectDuration - 1);
    return rowGraphFrames(layer, projectDuration)
      .map((frame) => `${(frame / last) * 220},${48 - (evaluateLayerSetting(layer, 'speed', frame, 1) / 8) * 40}`)
      .join(' ');
  }
  if (!clip) return '';
  return Array.from({ length: 33 }, (_, index) => {
    const progress = index / 32;
    const rate = sourceRateAt(clip.speed, clip.sourceIn + progress * (clip.sourceOut - clip.sourceIn));
    return `${progress * 220},${48 - (rate / 8) * 40}`;
  }).join(' ');
}

export function SpeedHelp({ keyed, helpId }: Readonly<{ keyed: boolean; helpId: string }>) {
  return (
    <HelpPopover label="Speed timing" guide="precise-clip-speed-curves">
      <p id={helpId}>
        1× is recorded speed: below 1× is slow motion, above is faster. Custom curve changes the speed over the length
        of this clip.
      </p>
      <p className="editor-help-tip">
        {keyed
          ? 'Tip: track speed keyframes override each clip’s own speed; Reset to 1× changes only the keyframe at this frame.'
          : 'Tip: the Track speed animation diamond changes speed for the whole track instead, overriding each clip’s own speed.'}
      </p>
    </HelpPopover>
  );
}

export function SpeedControls({
  project,
  clip,
  layer,
  frame,
  projectDuration,
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
  const rateId = `${helpId}-rate`;
  const layerContext = `${resetKey ?? layer.id}:${layer.id}`;
  const inputContext = `${layerContext}:${clip?.id ?? 'row'}`;
  const keyed = hasLayerKeys(layer, 'speed');
  const active = activeLayerSetting(layer, 'speed', frame);
  const validFrame = Number.isSafeInteger(frame) && frame >= 0 && frame <= 2_147_483_647;
  const base = clip ? sourceRateAt(clip.speed, sourceFrame ?? clip.sourceIn) : 1;
  const rate = evaluateLayerSetting(layer, 'speed', frame, base);
  const resetUnavailable = keyed
    ? !active || rate === 1
    : !clip || (clip.speed.mode === 'constant' && clip.speed.rate === 1);
  const resetTitle = keyed
    ? `Set only Speed at timeline frame ${frame} to 1×. Keep the other keyframes, settings and clip bases.`
    : "Reset only the selected clip's speed to constant 1×. Its curve is removed; track keyframes stay unchanged.";
  const updateBase = (speed: SpeedSettings): void => {
    if (clip && !disabled && !keyed) onEdit({ type: 'speed', clipId: clip.id, speed });
  };
  const updateKey = (value: number): void => {
    if (!disabled && validFrame && active)
      onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: 'speed', value });
  };
  const validateEdit = (command: EditCommand): string | null => {
    try {
      applyCommand(project, command);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'This speed conflicts with the timeline.';
    }
  };
  const reset = (): void => {
    if (keyed) updateKey(1);
    else updateBase({ mode: 'constant', rate: 1 });
  };
  const { scope, hint } = settingPresentation({
    keyed,
    active,
    baseAvailable: clip !== null,
    baseLabel: 'Clip',
    label: 'Speed',
    frame,
  });
  const graphRange = keyed
    ? `Timeline 0–${Math.max(0, projectDuration - 1)}`
    : `Source ${clip?.sourceIn ?? 0}–${clip?.sourceOut ?? 0} (OUT exclusive)`;
  const graphAvailable = keyed ? projectDuration > 0 : clip !== null;
  const customCurve = !keyed && clip?.speed.mode === 'curve';

  return (
    <section className="speed-settings declutter-speed" aria-label="Track and clip speed">
      <div className="speed-overview">
        <span>
          {clip && placedDuration !== null && placedDuration !== clip.sourceOut - clip.sourceIn && (
            <>
              {sourceSeconds(clip.sourceOut - clip.sourceIn)} <Icon name="arrow" size={12} />{' '}
              {sourceSeconds(placedDuration)}
            </>
          )}
        </span>
        <button
          type="button"
          className="text-button"
          aria-label="Reset speed to 1×"
          title={resetTitle}
          disabled={disabled || !validFrame || resetUnavailable}
          onClick={reset}
        >
          <Icon name="reset" size={12} />
          Reset
        </button>
      </div>
      {clip && keyed && (
        <p className="clip-speed-override">
          <Icon name="curve" size={15} />
          <span>Overridden by track Speed keyframes. This clip keeps its own speed for when they are removed.</span>
        </p>
      )}
      {!keyed && clip && (
        <BaseSpeedControls
          clip={clip}
          disabled={disabled}
          helpId={helpId}
          inputContext={inputContext}
          onChange={updateBase}
          validate={(speed) => validateEdit({ type: 'speed', clipId: clip.id, speed })}
        />
      )}
      {!keyed && clip?.speed.mode === 'curve' && sourceFrameCount !== null && (
        <ClipSpeedCurve
          key={`${project.id}:${clip.id}`}
          project={project}
          clip={clip}
          speed={clip.speed}
          sourceFrameCount={sourceFrameCount}
          frame={frame}
          sourceFrame={sourceFrame}
          disabled={disabled}
          onEdit={onEdit}
          onPreview={onPreview}
          onSeek={onSeek}
          onPause={onPause}
        />
      )}
      <div className={`layer-setting-heading${clip && !keyed ? ' clip-speed-row-heading' : ''}`}>
        <span title={hint}>
          <span>Track speed animation</span>
          <small className="layer-setting-kind" title={scope}>
            {keyed && <Icon name="curve" size={12} />}
            <span className="declutter-sr-only">{scope}</span>
          </small>
        </span>
        <span className="layer-setting-actions">
          {!keyed && clip && (
            <output title="Capture the selected clip's current rate as a track-wide keyframe">{rate}×</output>
          )}
          <KeyframeToggle
            layer={layer}
            setting="speed"
            label="Speed"
            frame={frame}
            value={rate}
            disabled={disabled}
            onEdit={onEdit}
          />
        </span>
      </div>
      {(keyed || !clip) && (
        <SpeedRateField
          id={rateId}
          aria-label="Track speed rate"
          aria-describedby={helpId}
          disabled={disabled || !validFrame || !active}
          value={rate}
          resetKey={`${layerContext}:${frame}:speed`}
          hint={hint}
          validate={(value) =>
            validateEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: 'speed', value })
          }
          onCommit={updateKey}
        />
      )}
      {graphAvailable && !customCurve && (
        <>
          <svg
            className="speed-graph"
            viewBox="0 0 220 55"
            role="img"
            aria-label={`${keyed ? 'Track' : 'Clip'} speed curve · ${graphRange}`}
          >
            <path d="M0 48H220" stroke="var(--line)" />
            <polyline
              points={speedGraphPoints(clip, layer, projectDuration)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
            />
          </svg>
          <div className="speed-graph-range">
            <span>{graphRange}</span>
            <span>0–8×</span>
          </div>
        </>
      )}
    </section>
  );
}
