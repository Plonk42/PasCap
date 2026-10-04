import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { editableClipSpeed } from '../shared/clip-speed.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys } from '../shared/keyframes.js';
import type { ProjectDocument, VideoClip, VideoLayer } from '../shared/model.js';
import { sourceRateAt, type SpeedSettings } from '../shared/speed.js';
import './declutter.css';
import { sourceSeconds } from './display.js';
import { ClipSpeedCurve } from './ClipSpeedCurve.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { NumberField } from './NumberField.js';
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
function BaseSpeedControls({ clip, disabled, helpId, inputContext, onChange }: Readonly<{ clip: VideoClip; disabled: boolean; helpId: string; inputContext: string | number; onChange: (speed: SpeedSettings) => void }>) {
  const speed = clip.speed;
  return <>
    <select aria-label="Speed mode" disabled={disabled} value={speedPreset(speed)} onChange={(event) => {
      if (event.target.value === 'constant') onChange({ mode: 'constant', rate: 1 });
      else if (event.target.value === 'curve') onChange(editableClipSpeed(clip));
      else onChange({ mode: 'ramp', startRate: event.target.value === 'ramp-up' ? 0.5 : 2, endRate: event.target.value === 'ramp-up' ? 2 : 0.5, curve: 'smooth', anchorIn: clip.sourceIn, anchorOut: clip.sourceOut });
    }}><option value="constant">Constant speed</option><option value="ramp-up">Ramp up</option><option value="ramp-down">Ramp down</option><option value="curve">Custom curve</option></select>
    {speed.mode === 'constant' && <>
      <div className="speed-presets">{[0.25, 0.5, 1, 2, 4].map((rate) => <button type="button" key={rate} className={`text-button ${speed.rate === rate ? 'active' : ''}`} disabled={disabled} onClick={() => onChange({ mode: 'constant', rate })}>{rate}×</button>)}</div>
      <label className="speed-field">Rate ×<NumberField aria-label="Clip speed rate" aria-describedby={helpId} min={0.1} max={8} step={0.05} value={speed.rate} disabled={disabled} resetKey={inputContext} hint="Selected clip base; used only while this layer has no Speed keys." onCommit={(rate) => onChange({ mode: 'constant', rate })} /></label>
    </>}
    {speed.mode === 'ramp' && <>
      <div className="range-fields"><label>Start ×<NumberField aria-label="Ramp start rate" min={0.1} max={8} step={0.1} disabled={disabled} value={speed.startRate} resetKey={`${inputContext}:${speed.anchorIn}:${speed.anchorOut}`} onCommit={(startRate) => onChange({ ...speed, startRate })} /></label><label>End ×<NumberField aria-label="Ramp end rate" min={0.1} max={8} step={0.1} disabled={disabled} value={speed.endRate} resetKey={`${inputContext}:${speed.anchorIn}:${speed.anchorOut}`} onCommit={(endRate) => onChange({ ...speed, endRate })} /></label></div>
      <label className="speed-field">Curve<select aria-label="Ramp curve" value={speed.curve} disabled={disabled} onChange={(event) => onChange({ ...speed, curve: event.target.value as typeof speed.curve })}><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="smooth">Smooth (S curve)</option></select></label>
    </>}
  </>;
}

function rowGraphFrames(layer: VideoLayer, projectDuration: number): number[] {
  const last = Math.max(0, projectDuration - 1);
  const frames = new Set(Array.from({ length: 33 }, (_, index) => index / 32 * last));
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
    return rowGraphFrames(layer, projectDuration).map((frame) => `${frame / last * 220},${48 - evaluateLayerSetting(layer, 'speed', frame, 1) / 8 * 40}`).join(' ');
  }
  if (!clip) return '';
  return Array.from({ length: 33 }, (_, index) => {
    const progress = index / 32;
    const rate = sourceRateAt(clip.speed, clip.sourceIn + progress * (clip.sourceOut - clip.sourceIn));
    return `${progress * 220},${48 - rate / 8 * 40}`;
  }).join(' ');
}

function rateHint(keyed: boolean, active: boolean, frame: number): string {
  if (!keyed) return 'Select a clip to edit its base, or click the diamond to key Speed for this whole row.';
  if (active) return `Layer Speed key at timeline frame ${frame}; all clips on this row use this curve.`;
  return 'Layer curve · click the Speed diamond to capture the evaluated rate and edit it at this frame.';
}

function speedScope(clip: VideoClip | null, keyed: boolean): string {
  if (keyed) return 'Layer curve · timeline time';
  return clip ? 'Selected clip base' : 'No selected clip base';
}

export function SpeedControls({ project, clip, layer, frame, projectDuration, placedDuration, disabled, onEdit, onPreview, onSeek, onPause, sourceFrame, sourceFrameCount, resetKey }: Readonly<SpeedControlsProps>) {
  const helpId = useId();
  const rateId = `${helpId}-rate`;
  const layerContext = `${resetKey ?? layer.id}:${layer.id}`;
  const inputContext = `${layerContext}:${clip?.id ?? 'row'}`;
  const keyed = hasLayerKeys(layer, 'speed');
  const active = activeLayerSetting(layer, 'speed', frame);
  const validFrame = Number.isSafeInteger(frame) && frame >= 0 && frame <= 2_147_483_647;
  const base = clip ? sourceRateAt(clip.speed, sourceFrame ?? clip.sourceIn) : 1;
  const rate = evaluateLayerSetting(layer, 'speed', frame, base);
  const resetUnavailable = keyed ? !active || rate === 1 : !clip || (clip.speed.mode === 'constant' && clip.speed.rate === 1);
  const resetTitle = keyed
    ? `Set only Speed at timeline frame ${frame} to 1×. Keep the other points, participants and clip bases.`
    : "Reset only the selected clip's speed to constant 1×. Its curve is removed; row points stay unchanged.";
  const updateBase = (speed: SpeedSettings): void => {
    if (clip && !disabled && !keyed) onEdit({ type: 'speed', clipId: clip.id, speed });
  };
  const updateKey = (value: number): void => {
    if (!disabled && validFrame && active) onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: 'speed', value });
  };
  const reset = (): void => {
    if (keyed) updateKey(1);
    else updateBase({ mode: 'constant', rate: 1 });
  };
  const scope = speedScope(clip, keyed);
  const graphRange = keyed ? `Timeline 0–${Math.max(0, projectDuration - 1)}` : `Source ${clip?.sourceIn ?? 0}–${clip?.sourceOut ?? 0} (OUT exclusive)`;
  const graphAvailable = keyed ? projectDuration > 0 : clip !== null;
  const customCurve = !keyed && clip?.speed.mode === 'curve';

  return <section className="speed-settings declutter-speed" aria-label="Layer and clip speed">
    <div className="speed-overview"><span>{clip && placedDuration !== null ? <>{sourceSeconds(clip.sourceOut - clip.sourceIn)} <Icon name="arrow" size={12} /> {sourceSeconds(placedDuration)}</> : 'No selected clip'}</span><button type="button" className="text-button" aria-label="Reset speed to 1×" title={resetTitle} disabled={disabled || !validFrame || resetUnavailable} onClick={reset}><Icon name="reset" size={12} />Reset</button></div>
    {clip && !keyed && <div className="clip-speed-scope">Clip speed</div>}
    {clip && keyed && <p className="clip-speed-override"><Icon name="curve" size={15} /><span>Row Speed overrides this clip. Its own speed is kept; remove the row's Speed keys to use it.</span></p>}
    {!keyed && clip && <BaseSpeedControls clip={clip} disabled={disabled} helpId={helpId} inputContext={inputContext} onChange={updateBase} />}
    {!keyed && clip?.speed.mode === 'curve' && sourceFrameCount !== null && <ClipSpeedCurve key={`${project.id}:${clip.id}`} project={project} clip={clip} speed={clip.speed} sourceFrameCount={sourceFrameCount} frame={frame} sourceFrame={sourceFrame} disabled={disabled} onEdit={onEdit} onPreview={onPreview} onSeek={onSeek} onPause={onPause} />}
    <div className={`layer-setting-heading${clip && !keyed ? ' clip-speed-row-heading' : ''}`}><span title={scope}>Row speed animation<small className="layer-setting-kind">{keyed && <Icon name="curve" size={12} />}<span className="declutter-sr-only">{scope}</span></small></span><span className="layer-setting-actions"><output title={keyed ? `Layer rate at timeline frame ${frame}` : 'Capture the selected clip base rate as a row-wide key'}>{rate.toFixed(2)}×</output><KeyframeToggle layer={layer} setting="speed" label="Speed" frame={frame} value={rate} disabled={disabled} onEdit={onEdit} /></span></div>
    {(keyed || !clip) && <label className="speed-field" htmlFor={rateId}>Layer rate ×<NumberField id={rateId} aria-label="Layer speed rate" aria-describedby={helpId} min={0.1} max={8} step={0.05} disabled={disabled || !validFrame || !active} value={rate} resetKey={`${layerContext}:${frame}:speed`} hint={rateHint(keyed, active, frame)} onCommit={updateKey} /></label>}
    {graphAvailable && !customCurve && <>
      <svg className="speed-graph" viewBox="0 0 220 55" role="img" aria-label={`${keyed ? 'Layer' : 'Clip base'} speed curve · ${graphRange}`}><path d="M0 48H220" stroke="var(--line)" /><polyline points={speedGraphPoints(clip, layer, projectDuration)} fill="none" stroke="var(--accent)" strokeWidth="2" /></svg>
      <div className="speed-graph-range"><span>{graphRange}</span><span>0–8×</span></div>
    </>}
    <HelpPopover label="Speed timing" className="control-help">
      <p id={helpId}>1× is recorded speed. Custom curve points belong to one clip and use original source frames; drag a point or enter its exact frame/rate. Their positions stay anchored when trimming or splitting. The logarithmic graph spans 0.1×–8×. Slow motion repeats recorded frames, without generated optical-flow images.</p>
      <p>The Row speed animation diamond keys the whole layer in project timeline time. Row keys override, rather than multiply, each clip's constant/ramp/custom speed. Between row points, capture with the diamond before changing its rate.</p>
      {!keyed && clip?.speed.mode === 'ramp' && <p>Selected clip ramp anchors: IN {clip.speed.anchorIn}, OUT {clip.speed.anchorOut} (exclusive). Trims do not move them.</p>}
      {!keyed && clip?.speed.mode === 'constant' && clip.speed.rate < 1 && <p>Slow motion repeats recorded frames.</p>}
      {keyed && <p>Reset to 1× changes only an enabled Speed value at this frame; it never clears the row curve. Use the diamonds or the shared point list to remove keys explicitly.</p>}
    </HelpPopover>
  </section>;
}
