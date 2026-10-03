import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys } from '../shared/keyframes.js';
import type { VideoClip, VideoLayer } from '../shared/model.js';
import { sourceRateAt, type SpeedSettings } from '../shared/speed.js';
import './declutter.css';
import { sourceSeconds } from './display.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { NumberField } from './NumberField.js';

export interface SpeedControlsProps {
  clip: VideoClip | null;
  layer: VideoLayer;
  frame: number;
  projectDuration: number;
  placedDuration: number | null;
  sourceFrame: number | null;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  /** Project/editing context; clip and layer identities are added locally. */
  resetKey?: string | number;
}

function speedPreset(speed: SpeedSettings): string {
  if (speed.mode === 'constant') return 'constant';
  return speed.endRate >= speed.startRate ? 'ramp-up' : 'ramp-down';
}

/** Static clip bases are independent of the layer curve and never create endpoint keys. */
function BaseSpeedControls({ clip, disabled, helpId, inputContext, onChange }: Readonly<{ clip: VideoClip; disabled: boolean; helpId: string; inputContext: string | number; onChange: (speed: SpeedSettings) => void }>) {
  const speed = clip.speed;
  return <>
    <select aria-label="Speed mode" disabled={disabled} value={speedPreset(speed)} onChange={(event) => {
      if (event.target.value === 'constant') onChange({ mode: 'constant', rate: 1 });
      else onChange({ mode: 'ramp', startRate: event.target.value === 'ramp-up' ? 0.5 : 2, endRate: event.target.value === 'ramp-up' ? 2 : 0.5, curve: 'smooth', anchorIn: clip.sourceIn, anchorOut: clip.sourceOut });
    }}><option value="constant">Constant speed</option><option value="ramp-up">Ramp up</option><option value="ramp-down">Ramp down</option></select>
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

export function SpeedControls({ clip, layer, frame, projectDuration, placedDuration, disabled, onEdit, sourceFrame, resetKey }: Readonly<SpeedControlsProps>) {
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
    : "Reset the selected clip's constant/ramp base to 1×. Layer points stay unchanged.";
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
  let scope = 'No selected clip base';
  if (clip) scope = 'Selected clip base';
  if (keyed) scope = 'Layer curve · timeline time';
  const graphRange = keyed ? `Timeline 0–${Math.max(0, projectDuration - 1)}` : `Source ${clip?.sourceIn ?? 0}–${clip?.sourceOut ?? 0} (OUT exclusive)`;
  const graphAvailable = keyed ? projectDuration > 0 : clip !== null;

  return <section className="speed-settings declutter-speed" aria-label="Layer and clip speed">
    <div className="speed-overview"><span>{placedDuration === null ? 'No selected clip' : `${sourceSeconds(placedDuration)} on timeline`}</span><button type="button" className="text-button" aria-label="Reset speed to 1×" title={resetTitle} disabled={disabled || !validFrame || resetUnavailable} onClick={reset}>Reset to 1×</button></div>
    <div className="layer-setting-heading"><span>Speed<small className="layer-setting-kind">{scope}</small></span><span className="layer-setting-actions"><output title={keyed ? `Layer rate at timeline frame ${frame}` : 'Selected clip base rate; outside the clip, its source IN rate is shown'}>{rate.toFixed(2)}×</output><KeyframeToggle layer={layer} setting="speed" label="Speed" frame={frame} value={rate} disabled={disabled} onEdit={onEdit} /></span></div>
    {(keyed || !clip) && <label className="speed-field" htmlFor={rateId}>Layer rate ×<NumberField id={rateId} aria-label="Layer speed rate" aria-describedby={helpId} min={0.1} max={8} step={0.05} disabled={disabled || !validFrame || !active} value={rate} resetKey={`${layerContext}:${frame}:speed`} hint={rateHint(keyed, active, frame)} onCommit={updateKey} /></label>}
    {!keyed && clip && <BaseSpeedControls clip={clip} disabled={disabled} helpId={helpId} inputContext={inputContext} onChange={updateBase} />}
    {graphAvailable && <>
      <svg className="speed-graph" viewBox="0 0 220 55" role="img" aria-label={`${keyed ? 'Layer' : 'Clip base'} speed curve · ${graphRange}`}><path d="M0 48H220" stroke="var(--line)" /><polyline points={speedGraphPoints(clip, layer, projectDuration)} fill="none" stroke="var(--accent)" strokeWidth="2" /></svg>
      <div className="speed-graph-range"><span>{graphRange}</span><span>0–8×</span></div>
    </>}
    <details className="control-help"><summary>Speed timing</summary>
      <p id={helpId}>1× is recorded speed. The diamond keys this whole layer in project timeline time; it does not add source-ramp endpoints. A keyed row overrides every clip's constant/ramp base. Between points, click the diamond before changing a rate.</p>
      {!keyed && clip?.speed.mode === 'ramp' && <p>Selected clip ramp anchors: IN {clip.speed.anchorIn}, OUT {clip.speed.anchorOut} (exclusive). Trims do not move them.</p>}
      {!keyed && clip?.speed.mode === 'constant' && clip.speed.rate < 1 && <p>Slow motion repeats recorded frames.</p>}
      {keyed && <p>Reset to 1× changes only an enabled Speed value at this frame; it never clears the row curve. Use the diamonds or the shared point list to remove keys explicitly.</p>}
    </details>
  </section>;
}
