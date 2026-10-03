import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR, type ColourSettings } from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import { colourAt, layerOpacityAt, opacityAt } from '../shared/composition.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys, type KeyframeSetting, type LayerKeyValues } from '../shared/keyframes.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument, Transition, VideoClip, VideoLayer } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';
import { formatTimecode } from '../shared/timing.js';
import { shortName, sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import { InspectorSection, type InspectorMode } from './InspectorSection.js';
import { KeyframeControls } from './KeyframeControls.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { NumberField } from './NumberField.js';
import { SpeedControls } from './SpeedControls.js';

export type { InspectorMode } from './InspectorSection.js';

interface Props {
  project: ProjectDocument; assets: MediaAsset[]; selectedClipId: string | null; selectedLayerId: string;
  boundaryId: string | null; frame: number; drafting: boolean;
  section: InspectorMode; onSection: (section: InspectorMode) => void;
  onEdit: (command: EditCommand) => void; children?: ReactNode;
}

const INSPECTOR_MODES: readonly { id: InspectorMode; label: string }[] = [
  { id: 'clip', label: 'Clip' }, { id: 'sequence', label: 'Sequence' }, { id: 'audio', label: 'Audio' },
];

function timelineNumberError(project: ProjectDocument, recovery: string): string | null {
  try { calculateLayout(project); return null; }
  catch (cause) { return `${cause instanceof Error ? cause.message : 'This timing is not valid.'} ${recovery}`; }
}

function InspectorTabs({ id, section, onSection }: Readonly<{ id: string; section: InspectorMode; onSection: Props['onSection'] }>) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, mode: InspectorMode): void => {
    const index = INSPECTOR_MODES.findIndex((item) => item.id === mode);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = (index + INSPECTOR_MODES.length - 1) % INSPECTOR_MODES.length; break;
      case 'ArrowRight': next = (index + 1) % INSPECTOR_MODES.length; break;
      case 'Home': next = 0; break;
      case 'End': next = INSPECTOR_MODES.length - 1; break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    const target = INSPECTOR_MODES[next]!.id;
    onSection(target);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-inspector-mode="${target}"]`)?.focus();
  };
  return <div className="panel-heading inspector-tabs" role="tablist" aria-label="Inspector sections">{INSPECTOR_MODES.map((mode) => <button key={mode.id} type="button" role="tab" id={`${id}-${mode.id}-tab`} data-inspector-mode={mode.id} aria-selected={section === mode.id} aria-controls={`${id}-${mode.id}-panel`} tabIndex={section === mode.id ? 0 : -1} onClick={() => onSection(mode.id)} onKeyDown={(event) => navigate(event, mode.id)}>{mode.label}</button>)}</div>;
}

interface LayerControlProps {
  layer: VideoLayer;
  clip: VideoClip | null;
  frame: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

function settingState(layer: VideoLayer, setting: KeyframeSetting, frame: number, baseAvailable: boolean) {
  const keyed = hasLayerKeys(layer, setting);
  const active = activeLayerSetting(layer, setting, frame);
  const validFrame = Number.isSafeInteger(frame) && frame >= 0 && frame <= 2_147_483_647;
  return { keyed, active, baseAvailable, editable: validFrame && (keyed ? active : baseAvailable) };
}

function settingScope(state: ReturnType<typeof settingState>, baseLabel: string): string {
  if (state.keyed) return state.active ? 'Layer key' : 'Layer curve';
  return state.baseAvailable ? baseLabel : 'No selected clip base';
}

function settingHint(state: ReturnType<typeof settingState>, label: string, frame: number): string {
  if (state.keyed && !state.active) return `Layer curve · click the ${label} diamond to capture a value and edit timeline frame ${frame}.`;
  if (!state.baseAvailable && !state.keyed) return `Select a clip for its static base, or click the ${label} diamond to key this whole row.`;
  if (state.active) return `Layer key at timeline frame ${frame}; edits change only this setting at the shared point.`;
  return 'Editing the static base. This setting has no keys on the row.';
}

function OpacityControl({ layer, clip, frame, disabled, onEdit, setting, id }: Readonly<LayerControlProps & { setting: 'layerOpacity' | 'clipOpacity'; id: string }>) {
  const isLayerOpacity = setting === 'layerOpacity';
  const label = isLayerOpacity ? 'Layer opacity' : 'Clip opacity';
  const state = settingState(layer, setting, frame, isLayerOpacity || clip !== null);
  let value = evaluateLayerSetting(layer, setting, frame, clip?.opacity ?? 1);
  if (isLayerOpacity) value = layerOpacityAt({ ...layer, enabled: true }, frame);
  else if (clip) value = opacityAt(clip, layer, frame);
  const hint = settingHint(state, label, frame);
  const commit = (opacity: number): void => {
    if (disabled || !state.editable) return;
    if (state.keyed) { onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting, value: opacity }); return; }
    if (isLayerOpacity) onEdit({ type: 'layer-update', layer: { ...layer, opacity } });
    else if (clip) onEdit({ type: 'opacity', clipId: clip.id, opacity });
  };
  return <div className="colour-control layer-keyed-control">
    <span><label htmlFor={id}>{label}<small className="layer-setting-kind">{settingScope(state, isLayerOpacity ? 'Layer base' : 'Clip base')}</small></label><span className="colour-control-actions"><output>{Math.round(value * 100)}%</output><KeyframeToggle layer={layer} setting={setting} label={label} frame={frame} value={value} disabled={disabled} onEdit={onEdit} /></span></span>
    <input id={id} type="range" aria-label={label} aria-describedby={`${id}-hint`} min={0} max={1} step={0.01} disabled={disabled || !state.editable} value={value} title={hint} onChange={(event) => commit(Number(event.target.value))} />
    <span id={`${id}-hint`} className={state.editable ? 'declutter-sr-only' : 'layer-setting-hint'}>{hint}</span>
  </div>;
}

type ColourControlDefinition = (typeof COLOUR_CONTROLS)[number];

function ColourControl({ layer, clip, frame, disabled, onEdit, control, value, id }: Readonly<LayerControlProps & { control: ColourControlDefinition; value: number; id: string }>) {
  const state = settingState(layer, control.key, frame, clip !== null);
  const hint = settingHint(state, control.label, frame);
  const resetTarget = state.keyed ? `timeline frame ${frame}` : 'the selected clip base';
  const commit = (nextValue: number): void => {
    if (disabled || !state.editable) return;
    if (state.keyed) { onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: control.key, value: nextValue }); return; }
    if (clip) onEdit({ type: 'colour', clipId: clip.id, colour: { ...clip.colour, [control.key]: nextValue } });
  };
  return <div className="colour-control layer-keyed-control">
    <span><label htmlFor={id}>{control.label}<small className="layer-setting-kind">{settingScope(state, 'Clip base')}</small></label><span className="colour-control-actions"><output>{value > 0 && NEUTRAL_COLOUR[control.key] === 0 ? '+' : ''}{value.toFixed(control.key === 'hue' ? 0 : 2)}<small>{control.unit}</small></output><KeyframeToggle layer={layer} setting={control.key} label={control.label} frame={frame} value={value} disabled={disabled} onEdit={onEdit} /><button type="button" className="icon-button" aria-label={`Reset ${control.label}`} title={`Reset only ${control.label} at ${resetTarget}`} disabled={disabled || !state.editable || value === NEUTRAL_COLOUR[control.key]} onClick={() => commit(NEUTRAL_COLOUR[control.key])}><Icon name="reset" size={13} /></button></span></span>
    <input id={id} type="range" aria-label={control.label} aria-describedby={`${id}-hint`} min={control.min} max={control.max} step={control.step} value={value} disabled={disabled || !state.editable} title={hint} onChange={(event) => commit(Number(event.target.value))} />
    <span id={`${id}-hint`} className={state.editable ? 'declutter-sr-only' : 'layer-setting-hint'}>{hint}</span>
  </div>;
}

function evaluatedLayerColour(layer: VideoLayer, clip: VideoClip | null, frame: number): ColourSettings {
  if (clip) return colourAt(clip, layer, frame);
  const colour: ColourSettings = { ...NEUTRAL_COLOUR };
  for (const control of COLOUR_CONTROLS) colour[control.key] = evaluateLayerSetting(layer, control.key, frame, NEUTRAL_COLOUR[control.key]);
  return colour;
}

function ColourSection({ layer, clip, frame, disabled, onEdit, id }: Readonly<LayerControlProps & { id: string }>) {
  const colour = evaluatedLayerColour(layer, clip, frame);
  const animated = COLOUR_CONTROLS.some((control) => hasLayerKeys(layer, control.key));
  const point = layer.keyframes.find((key) => key.frame === frame);
  const activeColours = point ? COLOUR_CONTROLS.filter((control) => point.values[control.key] !== null) : [];
  const canResetKeys = activeColours.some((control) => point!.values[control.key] !== NEUTRAL_COLOUR[control.key]);
  const canResetBase = clip !== null && COLOUR_CONTROLS.some((control) => clip.colour[control.key] !== NEUTRAL_COLOUR[control.key]);
  const canReset = animated ? canResetKeys : canResetBase;
  const resetTitle = animated
    ? 'Reset only the enabled colour settings at this shared point. Other participants, points and clip bases stay unchanged.'
    : "Reset the selected clip's static base grade.";
  let gradeLabel = clip ? 'Selected clip base' : 'Layer colour · no selected clip';
  if (animated) gradeLabel = `Layer colour · timeline frame ${frame}`;
  const reset = (): void => {
    if (disabled || !canReset) return;
    if (!animated) {
      if (clip) onEdit({ type: 'colour', clipId: clip.id, colour: { ...NEUTRAL_COLOUR } });
      return;
    }
    if (!point) return;
    const values: LayerKeyValues = { ...point.values };
    for (const control of activeColours) values[control.key] = NEUTRAL_COLOUR[control.key];
    onEdit({ type: 'layer-update', layer: { ...layer, keyframes: layer.keyframes.map((key) => key.frame === point.frame ? { ...key, values } : key) } });
  };
  return <InspectorSection id="colour" title="Colour">
    <div className="grade-heading"><span className="grade-context">{gradeLabel}</span><button type="button" className="text-button" disabled={disabled || !canReset} aria-label="Reset colour" title={resetTitle} onClick={reset}><Icon name="reset" size={13} />{animated ? 'Reset keys' : 'Reset'}</button></div>
    <div className="colour-controls">{COLOUR_CONTROLS.map((control) => <ColourControl key={control.key} layer={layer} clip={clip} frame={frame} disabled={disabled} onEdit={onEdit} control={control} value={colour[control.key]} id={`${id}-${control.key}`} />)}</div>
    <details className="control-help colour-help"><summary>Colour animation</summary><p>Each diamond keys only its own setting for this whole layer, in project timeline time. A keyed channel overrides that setting on every clip in the row; an unkeyed channel uses each clip's static base. Between points, click the diamond before editing. Reset keys changes only this point's enabled colour settings; the individual reset buttons also handle unkeyed clip bases.</p></details>
  </InspectorSection>;
}

export function Inspector({ project, assets, selectedClipId, selectedLayerId, boundaryId, frame, drafting, section, onSection, onEdit, children }: Readonly<Props>) {
  const inspectorId = useId();
  const colourControlId = useId();
  const layer = project.layers.find((item) => item.id === selectedLayerId);
  const clip = project.clips.find((item) => item.id === selectedClipId && item.layerId === selectedLayerId);
  const asset = assets.find((item) => item.id === clip?.mediaId);
  const position = project.clips.findIndex((item) => item.id === clip?.id);
  const layout = calculateLayout(project);
  const placed = layout.clips.find((item) => item.clip.id === clip?.id);
  const sourceFrame = placed && frame >= placed.start && frame < placed.end ? placed.retiming.sourceAt(frame - placed.start) : null;
  const boundary = project.transitions.find((item) => item.leftId === boundaryId);
  const boundaryIndex = boundary ? project.transitions.indexOf(boundary) : -1;
  const left = project.clips.find((item) => item.id === boundary?.leftId);
  const right = project.clips.find((item) => item.id === boundary?.rightId);
  const inputContext = `${project.id}:${layer?.id}:${clip?.id ?? 'row'}`;
  const primary = layout.clips.filter((item) => item.clip.layerId === project.layers[0]!.id);
  const clipTimingError = (changes: Partial<Pick<VideoClip, 'sourceIn' | 'sourceOut' | 'start'>>): string | null => clip
    ? timelineNumberError({ ...project, clips: project.clips.map((item) => item.id === clip.id ? { ...item, ...changes } : item) }, 'Adjust this range/placement or the conflicting fades and clips.') : null;
  const setTransition = (type: Transition['type'], duration: number): void => {
    if (!boundary) return;
    const pair = { leftId: boundary.leftId, rightId: boundary.rightId };
    if (type === 'cut') onEdit({ type: 'transition', transition: { ...pair, type, duration: 0 } });
    else onEdit({ type: 'transition', transition: { ...pair, type, duration } });
  };

  return <aside className="inspector-panel panel declutter-inspector" aria-label="Clip inspector">
    <InspectorTabs id={inspectorId} section={section} onSection={onSection} />
    <div role="tabpanel" id={`${inspectorId}-clip-panel`} aria-labelledby={`${inspectorId}-clip-tab`} hidden={section !== 'clip'}>
      {layer ? <>
        <KeyframeControls projectId={project.id} layer={layer} frame={frame} duration={layout.duration} disabled={drafting} onEdit={onEdit} />
        {clip && asset && placed ? <div className="selected-clip-name"><strong title={asset.name}>{shortName(asset.name)}</strong><span>Excerpt {position + 1} · {sourceSeconds(placed.duration)} · {layer.name}</span></div>
          : <div className="selected-clip-name"><strong title={layer.name}>{layer.name}</strong><span>Whole video row · select a clip for its source range and static bases.</span></div>}
        {clip && asset && placed && <InspectorSection id="source" title="Source range" defaultOpen={false}>
          <section className="source-range" aria-label="Source range">
            <div className="section-label"><span>{sourceSeconds(asset.metadata.frameCount)} original</span><span>{sourceFrame === null ? 'Playhead outside clip' : `Source frame ${sourceFrame}`}</span></div>
            <div className="range-fields"><label htmlFor={`${colourControlId}-in`}>IN <output>{formatTimecode(clip.sourceIn)}</output><NumberField id={`${colourControlId}-in`} aria-label="Source IN frame" aria-describedby={`${colourControlId}-source-help`} min={0} max={clip.sourceOut - 1} integer step={1} value={clip.sourceIn} disabled={drafting} resetKey={inputContext} validate={(sourceIn) => clipTimingError({ sourceIn })} onCommit={(sourceIn) => onEdit({ type: 'trim', clipId: clip.id, sourceIn, sourceOut: clip.sourceOut })} /></label><label htmlFor={`${colourControlId}-out`}>OUT <output>{formatTimecode(clip.sourceOut)}</output><NumberField id={`${colourControlId}-out`} aria-label="Source OUT frame" aria-describedby={`${colourControlId}-source-help`} min={clip.sourceIn + 1} max={Math.min(asset.metadata.frameCount, 2_147_483_647)} integer step={1} value={clip.sourceOut} disabled={drafting} resetKey={inputContext} validate={(sourceOut) => clipTimingError({ sourceOut })} onCommit={(sourceOut) => onEdit({ type: 'trim', clipId: clip.id, sourceIn: clip.sourceIn, sourceOut })} /></label></div>
            <div className="range-availability" aria-label="Recoverable source footage"><span>{sourceSeconds(clip.sourceIn)} before</span><span>{sourceSeconds(asset.metadata.frameCount - clip.sourceOut)} after</span></div>
            <button className="text-button restore-range" disabled={drafting || (clip.sourceIn === 0 && clip.sourceOut === asset.metadata.frameCount)} onClick={() => onEdit({ type: 'trim', clipId: clip.id, sourceIn: 0, sourceOut: asset.metadata.frameCount })}><Icon name="reset" size={13} />Restore full recording</button>
            <details className="control-help"><summary>Source timing</summary><p id={`${colourControlId}-source-help`}>Original recording frames; OUT is exclusive. Layer keyframes stay in project timeline time when this source range changes.</p></details>
          </section>
        </InspectorSection>}
        <InspectorSection id="layer-opacity" title="Layer & opacity" defaultOpen={false}>
          <section className="layer-inspector" aria-label="Layer appearance">
            {clip && placed && <>
              <label className="speed-field">Video layer<select aria-label="Clip video layer" disabled={drafting} value={clip.layerId} onChange={(event) => onEdit({ type: 'place', clipId: clip.id, layerId: event.target.value, start: placed.start, index: position })}>{project.layers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              {clip.layerId !== project.layers[0]!.id && <label className="speed-field">Timeline start frame<NumberField aria-label="Clip timeline start" min={0} max={2_147_483_647 - placed.duration} integer step={1} disabled={drafting} value={clip.start} resetKey={inputContext} hint="Absolute timeline frames; this layer's points do not move with the clip." validate={(start) => clipTimingError({ start })} onCommit={(start) => onEdit({ type: 'place', clipId: clip.id, layerId: clip.layerId, start, index: position })} /></label>}
            </>}
            <OpacityControl layer={layer} clip={clip ?? null} frame={frame} disabled={drafting} onEdit={onEdit} setting="layerOpacity" id={`${colourControlId}-layer-opacity`} />
            <OpacityControl layer={layer} clip={clip ?? null} frame={frame} disabled={drafting} onEdit={onEdit} setting="clipOpacity" id={`${colourControlId}-clip-opacity`} />
            <details className="control-help"><summary>Opacity scope</summary><p>Layer opacity is applied after the row's clips are combined, including dissolves. Clip opacity keys are also row-wide: they replace each clip's base opacity, before the combined layer opacity is applied. Unkeyed channels keep their static bases.</p></details>
          </section>
        </InspectorSection>
        <InspectorSection id="speed" title="Speed" defaultOpen={false}><SpeedControls resetKey={project.id} clip={clip ?? null} layer={layer} frame={frame} projectDuration={layout.duration} placedDuration={placed?.duration ?? null} disabled={drafting} sourceFrame={sourceFrame} onEdit={onEdit} /></InspectorSection>
        <ColourSection layer={layer} clip={clip ?? null} frame={frame} disabled={drafting} onEdit={onEdit} id={colourControlId} />
      </> : <div className="inspector-empty">Select a video layer or clip in the timeline.</div>}
    </div>
    <div role="tabpanel" id={`${inspectorId}-sequence-panel`} aria-labelledby={`${inspectorId}-sequence-tab`} hidden={section !== 'sequence'}>
      {boundary && <InspectorSection id="transition" title="Transition">
        <section className="boundary-inspector" aria-label="Boundary transition">
          <p title={`Transition ${boundaryIndex + 1}`}>{shortName(assets.find((item) => item.id === left?.mediaId)?.name ?? '')} <Icon name="arrow" size={12} /> {shortName(assets.find((item) => item.id === right?.mediaId)?.name ?? '')}</p>
          <div className="transition-fields">
            <label>Type<select aria-label="Transition type" disabled={drafting} value={boundary.type} onChange={(event) => setTransition(event.target.value as Transition['type'], boundary.type === 'cut' ? 30 : boundary.duration)}><option value="cut">Cut</option><option value="fade-through-black">Fade through black</option><option value="cross-dissolve">Cross-dissolve</option></select></label>
            <label>Timeline frames<NumberField aria-label="Transition duration" aria-describedby={`${colourControlId}-transition-help`} min={boundary.type === 'fade-through-black' ? 2 : 1} max={2_147_483_647} integer step={1} disabled={drafting || boundary.type === 'cut'} value={boundary.duration} resetKey={`${project.id}:${boundary.leftId}:${boundary.rightId}:${boundary.type}`} validate={(duration) => boundary.type === 'cut' ? null : timelineNumberError({ ...project, transitions: project.transitions.map((item) => item === boundary ? { ...boundary, duration } : item) }, 'Shorten this transition or another fade on its two clips.')} onCommit={(duration) => setTransition(boundary.type, duration)} /></label>
          </div>
          <details className="control-help"><summary>Transition timing</summary><p id={`${colourControlId}-transition-help`}>Timeline frames after retiming. Transition and fade regions must fit their clips.</p></details>
        </section>
      </InspectorSection>}
      <div className="inspector-empty" hidden={boundary !== undefined}>Select a transition in the primary track.</div>
      <InspectorSection id="fades" title="Sequence fades">
        <section className="edge-fade-settings" aria-label="Sequence fades">
          <div className="range-fields">
            <label>Opening <small>frames</small><NumberField aria-label="Opening fade" aria-describedby={`${colourControlId}-fades-help`} min={0} max={Math.min(primary[0]?.duration ?? 0, 2_147_483_647)} integer step={1} value={project.openingFade} disabled={drafting || !primary.length} resetKey={project.id} validate={(openingFade) => timelineNumberError({ ...project, openingFade }, 'Shorten the opening fade or the other fades/transitions on the first primary clip.')} onCommit={(opening) => onEdit({ type: 'fades', opening, closing: project.closingFade })} /></label>
            <label>Closing <small>frames</small><NumberField aria-label="Closing fade" aria-describedby={`${colourControlId}-fades-help`} min={0} max={Math.min(primary.at(-1)?.duration ?? 0, 2_147_483_647)} integer step={1} value={project.closingFade} disabled={drafting || !primary.length} resetKey={project.id} validate={(closingFade) => timelineNumberError({ ...project, closingFade }, 'Shorten the closing fade or the other fades/transitions on the last primary clip.')} onCommit={(closing) => onEdit({ type: 'fades', opening: project.openingFade, closing })} /></label>
          </div>
          <details className="control-help"><summary>Fade timing</summary><p id={`${colourControlId}-fades-help`}>Timeline frames on the first and last primary clips. 0 disables a fade.</p></details>
        </section>
      </InspectorSection>
    </div>
    <div role="tabpanel" id={`${inspectorId}-audio-panel`} aria-labelledby={`${inspectorId}-audio-tab`} hidden={section !== 'audio'}>
      <InspectorSection id="music" title="Music">{children}</InspectorSection>
    </div>
  </aside>;
}
