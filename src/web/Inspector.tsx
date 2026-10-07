import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR, type ColourSettings } from '../shared/colour.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { colourAt } from '../shared/composition.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys, type KeyframeSetting } from '../shared/keyframes.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument, Transition, VideoClip, VideoLayer } from '../shared/model.js';
import { sourceRateAt } from '../shared/speed.js';
import { calculateLayout, type TimelineLayout } from '../shared/timeline.js';
import { formatTimecode } from '../shared/timing.js';
import { colourResetCommands } from './colour-reset.js';
import { shortName, sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import {
  InspectorExpansionContext,
  InspectorExpansionControls,
  InspectorSection,
  useInspectorExpansion,
  type InspectorMode,
} from './InspectorSection.js';
import { KeyframeControls } from './KeyframeControls.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { clipStartRestriction } from './layer-actions.js';
import { NumberField } from './NumberField.js';
import { settingPresentation } from './setting-scope.js';
import { RangeSettingControl } from './SettingValueControl.js';
import { TransformSection } from './SpatialControls.js';
import { SpeedControls, SpeedHelp } from './SpeedControls.js';
import { planTimelineDrop } from './timeline-placement.js';
import type { DraftPreview } from './Timeline.js';
import './ui-controls.css';

export type { InspectorMode } from './InspectorSection.js';

interface Props {
  project: ProjectDocument;
  assets: MediaAsset[];
  selectedClipId: string | null;
  selectedLayerId: string;
  boundaryId: string | null;
  frame: number;
  drafting: boolean;
  section: InspectorMode;
  onSection: (section: InspectorMode) => void;
  onEdit: (command: EditCommand | readonly EditCommand[]) => void;
  children?: ReactNode;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
}

const INSPECTOR_MODES: readonly { id: InspectorMode; label: string; accessibleLabel?: string }[] = [
  { id: 'clip', label: 'Clip' },
  { id: 'keyframes', label: 'Keyframes', accessibleLabel: 'Layer keyframes' },
  { id: 'sequence', label: 'Sequence' },
  { id: 'audio', label: 'Audio' },
];

function commandNumberError(project: ProjectDocument, command: EditCommand, recovery: string): string | null {
  try {
    applyCommand(project, command);
    return null;
  } catch (cause) {
    return `${cause instanceof Error ? cause.message : 'This timing is not valid.'} ${recovery}`;
  }
}

function placementHint(layer: VideoLayer | undefined, restriction: string | null): string {
  if (restriction) return restriction;
  return layer?.ripple
    ? 'First clip anchor in project frames; later clips follow it. Row points, music and other tracks stay fixed.'
    : 'Independent project-frame start; row points, music and other clips stay fixed.';
}

function transitionHasGap(boundary: Transition | undefined, layout: TimelineLayout): boolean {
  if (!boundary || boundary.type === 'cross-dissolve') return false;
  const left = layout.clips.find((item) => item.clip.id === boundary.leftId);
  const right = layout.clips.find((item) => item.clip.id === boundary.rightId);
  return !!left && !!right && left.end !== right.start;
}

function clipRangeError(
  project: ProjectDocument,
  clip: VideoClip | undefined,
  changes: Partial<Pick<VideoClip, 'sourceIn' | 'sourceOut'>>,
): string | null {
  if (!clip) return null;
  return commandNumberError(
    project,
    {
      type: 'trim',
      clipId: clip.id,
      sourceIn: changes.sourceIn ?? clip.sourceIn,
      sourceOut: changes.sourceOut ?? clip.sourceOut,
    },
    'Adjust this range or the conflicting fades and clips.',
  );
}

function InspectorTabs({
  id,
  section,
  onSection,
}: Readonly<{ id: string; section: InspectorMode; onSection: Props['onSection'] }>) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, mode: InspectorMode): void => {
    const index = INSPECTOR_MODES.findIndex((item) => item.id === mode);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (index + INSPECTOR_MODES.length - 1) % INSPECTOR_MODES.length;
        break;
      case 'ArrowRight':
        next = (index + 1) % INSPECTOR_MODES.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = INSPECTOR_MODES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = INSPECTOR_MODES[next]!.id;
    onSection(target);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-inspector-mode="${target}"]`)?.focus();
  };
  return (
    <div className="panel-heading inspector-tabs" role="tablist" aria-label="Inspector sections">
      {INSPECTOR_MODES.map((mode) => (
        <button
          key={mode.id}
          type="button"
          role="tab"
          id={`${id}-${mode.id}-tab`}
          data-inspector-mode={mode.id}
          aria-label={mode.accessibleLabel}
          aria-selected={section === mode.id}
          aria-controls={`${id}-${mode.id}-panel`}
          tabIndex={section === mode.id ? 0 : -1}
          onClick={() => onSection(mode.id)}
          onKeyDown={(event) => navigate(event, mode.id)}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

interface LayerControlProps {
  layer: VideoLayer;
  clip: VideoClip | null;
  frame: number;
  resetKey: string;
  disabled: boolean;
  onEdit: Props['onEdit'];
}

function settingState(layer: VideoLayer, setting: KeyframeSetting, frame: number, baseAvailable: boolean) {
  const keyed = hasLayerKeys(layer, setting);
  const active = activeLayerSetting(layer, setting, frame);
  const validFrame = Number.isSafeInteger(frame) && frame >= 0 && frame <= 2_147_483_647;
  return { keyed, active, baseAvailable, editable: validFrame && (keyed ? active : baseAvailable) };
}

function SettingScope({ keyed, scope }: Readonly<{ keyed: boolean; scope: string }>) {
  return (
    <small className="layer-setting-kind" title={scope}>
      {keyed && <Icon name="curve" size={12} />}
      <span className="declutter-sr-only">{scope}</span>
    </small>
  );
}

function OpacityControl({
  layer,
  frame,
  resetKey,
  disabled,
  onEdit,
  id,
}: Readonly<Omit<LayerControlProps, 'clip'> & { id: string }>) {
  const state = settingState(layer, 'opacity', frame, true);
  const value = evaluateLayerSetting(layer, 'opacity', frame, layer.opacity);
  const { scope, hint } = settingPresentation({
    ...state,
    baseLabel: 'Layer',
    label: 'Opacity',
    frame,
  });
  const resetTarget = state.keyed ? `timeline frame ${frame}` : 'the selected row';
  const commit = (opacity: number): void => {
    if (disabled || !state.editable) return;
    if (state.keyed) {
      onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: 'opacity', value: opacity });
      return;
    }
    onEdit({ type: 'opacity', layerId: layer.id, opacity });
  };
  return (
    <div className="colour-control layer-keyed-control" data-animated={state.keyed} data-key-at-playhead={state.active}>
      <RangeSettingControl
        setting="opacity"
        id={id}
        label="Opacity"
        value={value}
        disabled={disabled || !state.editable}
        onCommit={commit}
        hint={hint}
        scope={<SettingScope keyed={state.keyed} scope={scope} />}
        resetTitle={`Reset only Opacity at ${resetTarget} to 100%`}
        exact={{ resetKey: `${resetKey}:opacity:${state.keyed ? 'key' : 'layer'}` }}
        actions={
          <KeyframeToggle
            layer={layer}
            setting="opacity"
            label="Opacity"
            frame={frame}
            value={value}
            disabled={disabled}
            onEdit={onEdit}
          />
        }
      />
    </div>
  );
}

type ColourControlDefinition = (typeof COLOUR_CONTROLS)[number];

function ColourControl({
  layer,
  clip,
  frame,
  resetKey,
  disabled,
  onEdit,
  control,
  value,
  id,
}: Readonly<LayerControlProps & { control: ColourControlDefinition; value: number; id: string }>) {
  const state = settingState(layer, control.key, frame, clip !== null);
  const { scope, hint } = settingPresentation({ ...state, baseLabel: 'Clip', label: control.label, frame });
  const resetTarget = state.keyed ? `timeline frame ${frame}` : 'the selected clip';
  const commit = (nextValue: number): void => {
    if (disabled || !state.editable) return;
    if (state.keyed) {
      onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: control.key, value: nextValue });
      return;
    }
    if (clip) onEdit({ type: 'colour', clipId: clip.id, colour: { ...clip.colour, [control.key]: nextValue } });
  };
  return (
    <div className="colour-control layer-keyed-control" data-animated={state.keyed} data-key-at-playhead={state.active}>
      <RangeSettingControl
        setting={control.key}
        id={id}
        value={value}
        disabled={disabled || !state.editable}
        onCommit={commit}
        hint={hint}
        scope={<SettingScope keyed={state.keyed} scope={scope} />}
        resetTitle={`Reset only ${control.label} at ${resetTarget}`}
        exact={{ resetKey: `${resetKey}:${control.key}:${state.keyed ? 'key' : 'clip'}` }}
        actions={
          <KeyframeToggle
            layer={layer}
            setting={control.key}
            label={control.label}
            frame={frame}
            value={value}
            disabled={disabled}
            onEdit={onEdit}
          />
        }
      />
    </div>
  );
}

function evaluatedLayerColour(layer: VideoLayer, clip: VideoClip | null, frame: number): ColourSettings {
  if (clip) return colourAt(clip, layer, frame);
  const colour: ColourSettings = { ...NEUTRAL_COLOUR };
  for (const control of COLOUR_CONTROLS)
    colour[control.key] = evaluateLayerSetting(layer, control.key, frame, NEUTRAL_COLOUR[control.key]);
  return colour;
}

function ColourSection({
  layer,
  clip,
  frame,
  resetKey,
  disabled,
  onEdit,
  id,
}: Readonly<LayerControlProps & { id: string }>) {
  const colour = evaluatedLayerColour(layer, clip, frame);
  const opacity = evaluateLayerSetting(layer, 'opacity', frame, layer.opacity);
  const animated =
    hasLayerKeys(layer, 'opacity') || COLOUR_CONTROLS.some((control) => hasLayerKeys(layer, control.key));
  const resetCommands = colourResetCommands(layer, clip, frame);
  const adjusted =
    COLOUR_CONTROLS.filter(
      (control) => colour[control.key] !== NEUTRAL_COLOUR[control.key] || hasLayerKeys(layer, control.key),
    ).length + Number(opacity !== 1 || hasLayerKeys(layer, 'opacity'));
  const canReset = resetCommands.length > 0;
  const resetTitle = animated
    ? 'Reset only the enabled Colour settings, including Opacity, at this shared point. Other settings and points stay unchanged.'
    : 'Reset Colour on the selected clip and Opacity on the whole row. Row points stay unchanged.';
  let gradeLabel = clip ? 'Selected clip · row Opacity' : 'Row Opacity · no selected clip';
  if (animated) gradeLabel = `Layer colour · timeline frame ${frame}`;
  const reset = (): void => {
    if (disabled || !canReset) return;
    onEdit(resetCommands);
  };
  return (
    <InspectorSection
      id="colour"
      title="Colour"
      icon="colour"
      modified={adjusted > 0}
      help={
        <HelpPopover label="Colour animation">
          <p>
            Each diamond keys only its own setting for this whole layer, in project timeline time. A keyed channel
            overrides that setting on every clip in the row. Opacity always affects the whole row, even without
            keyframes or clips; other unanimated Colour settings edit the selected clip. Between points, click the
            diamond before editing. Reset keys changes only this point's enabled Colour settings, including Opacity;
            individual resets change only their own setting. Without Colour animation, Reset restores the selected
            clip's Colour and the row's Opacity to 100% in one Undo step.
          </p>
        </HelpPopover>
      }
    >
      <div className="grade-heading">
        <span className={`grade-context${animated ? '' : ' declutter-sr-only'}`}>{gradeLabel}</span>
        <button
          type="button"
          className="text-button"
          disabled={disabled || !canReset}
          aria-label="Reset colour"
          title={resetTitle}
          onClick={reset}
        >
          <Icon name="reset" size={13} />
          {animated ? 'Reset keys' : 'Reset'}
        </button>
      </div>
      <div className="colour-controls">
        <OpacityControl
          layer={layer}
          frame={frame}
          resetKey={resetKey}
          disabled={disabled}
          onEdit={onEdit}
          id={`${id}-opacity`}
        />
        {COLOUR_CONTROLS.map((control) => (
          <ColourControl
            key={control.key}
            layer={layer}
            clip={clip}
            frame={frame}
            resetKey={resetKey}
            disabled={disabled}
            onEdit={onEdit}
            control={control}
            value={colour[control.key]}
            id={`${id}-${control.key}`}
          />
        ))}
      </div>
    </InspectorSection>
  );
}

function SequenceControls({
  project,
  layer,
  assets,
  boundaryId,
  layout,
  drafting,
  onEdit,
  id,
}: Readonly<
  Pick<Props, 'project' | 'assets' | 'boundaryId' | 'drafting' | 'onEdit'> & {
    layer: VideoLayer;
    layout: TimelineLayout;
    id: string;
  }
>) {
  const boundary = layer.transitions.find((item) => item.leftId === boundaryId);
  const boundaryIndex = boundary ? layer.transitions.indexOf(boundary) : -1;
  const left = project.clips.find((item) => item.id === boundary?.leftId);
  const right = project.clips.find((item) => item.id === boundary?.rightId);
  const trackClips = layout.clips.filter((item) => item.clip.layerId === layer.id);
  const transitionGap = transitionHasGap(boundary, layout);
  const setTransition = (type: Transition['type'], duration: number): void => {
    if (!boundary) return;
    const pair = { leftId: boundary.leftId, rightId: boundary.rightId };
    if (type === 'cut') onEdit({ type: 'transition', transition: { ...pair, type, duration: 0 } });
    else onEdit({ type: 'transition', transition: { ...pair, type, duration } });
  };
  return (
    <>
      {boundary && (
        <InspectorSection
          id="transition"
          title="Transition"
          icon="curve"
          modified={boundary.type !== 'cut'}
          help={
            <HelpPopover label="Transition timing">
              <p id={`${id}-transition-help`}>
                Timeline frames after retiming, on this track only. Fade-through-black darkens this row without
                revealing lower footage. Non-cut transitions need touching clips or an existing dissolve; close a gap
                explicitly first. A positioned dissolve moves only its right clip to the exact overlap. Conflicts reject
                the complete edit, never shorten another fade or transition.
              </p>
            </HelpPopover>
          }
        >
          <section className="boundary-inspector" aria-label="Boundary transition">
            <p title={`Transition ${boundaryIndex + 1}`}>
              {shortName(assets.find((item) => item.id === left?.mediaId)?.name ?? '')} <Icon name="arrow" size={12} />{' '}
              {shortName(assets.find((item) => item.id === right?.mediaId)?.name ?? '')}
            </p>
            <div className="transition-fields">
              <label>
                Type
                <select
                  aria-label="Transition type"
                  aria-describedby={transitionGap ? `${id}-transition-gap` : `${id}-transition-help`}
                  disabled={drafting}
                  value={boundary.type}
                  onChange={(event) =>
                    setTransition(
                      event.target.value as Transition['type'],
                      boundary.type === 'cut' ? 30 : boundary.duration,
                    )
                  }
                >
                  <option value="cut">Cut</option>
                  <option value="fade-through-black" disabled={transitionGap}>
                    Fade through black
                  </option>
                  <option value="cross-dissolve" disabled={transitionGap}>
                    Cross-dissolve
                  </option>
                </select>
              </label>
              <label>
                Timeline frames
                <NumberField
                  aria-label="Transition duration"
                  aria-describedby={`${id}-transition-help`}
                  min={boundary.type === 'fade-through-black' ? 2 : 1}
                  max={2_147_483_647}
                  integer
                  step={1}
                  disabled={drafting || boundary.type === 'cut'}
                  value={boundary.duration}
                  resetKey={`${project.id}:${layer.id}:${boundary.leftId}:${boundary.rightId}:${boundary.type}`}
                  validate={(duration) =>
                    boundary.type === 'cut'
                      ? null
                      : commandNumberError(
                          project,
                          { type: 'transition', transition: { ...boundary, duration } },
                          'Shorten this transition or adjust conflicting fades/placements on this track.',
                        )
                  }
                  onCommit={(duration) => setTransition(boundary.type, duration)}
                />
              </label>
            </div>
            {transitionGap && (
              <p className="control-hint" id={`${id}-transition-gap`}>
                These clips have a gap. Close it explicitly, or enable this track’s Ripple in Layer options, before
                adding a fade or dissolve.
              </p>
            )}
          </section>
        </InspectorSection>
      )}
      <div className="inspector-empty" hidden={boundary !== undefined}>
        Select a transition on {layer.name}.
      </div>
      <InspectorSection
        id="fades"
        title="Sequence fades"
        icon="start"
        modified={layer.openingFade > 0 || layer.closingFade > 0}
        help={
          <HelpPopover label="Fade timing">
            <p id={`${id}-fades-help`}>
              Timeline frames on this track’s first and last clips, at their actual placements. 0 disables a fade. These
              fades darken this row toward black without changing its coverage or fading another track. Empty tracks
              retain their stored fades.
            </p>
          </HelpPopover>
        }
      >
        <section className="edge-fade-settings" aria-label="Sequence fades">
          <div className="range-fields">
            <label>
              Opening <small>frames</small>
              <NumberField
                aria-label="Opening fade"
                aria-describedby={`${id}-fades-help`}
                min={0}
                max={Math.min(trackClips[0]?.duration ?? 0, 2_147_483_647)}
                integer
                step={1}
                value={layer.openingFade}
                disabled={drafting || !trackClips.length}
                resetKey={`${project.id}:${layer.id}`}
                validate={(opening) =>
                  commandNumberError(
                    project,
                    { type: 'fades', layerId: layer.id, opening, closing: layer.closingFade },
                    'Shorten the opening fade or adjust the first clip’s other fades/transitions.',
                  )
                }
                onCommit={(opening) =>
                  onEdit({ type: 'fades', layerId: layer.id, opening, closing: layer.closingFade })
                }
              />
            </label>
            <label>
              Closing <small>frames</small>
              <NumberField
                aria-label="Closing fade"
                aria-describedby={`${id}-fades-help`}
                min={0}
                max={Math.min(trackClips.at(-1)?.duration ?? 0, 2_147_483_647)}
                integer
                step={1}
                value={layer.closingFade}
                disabled={drafting || !trackClips.length}
                resetKey={`${project.id}:${layer.id}`}
                validate={(closing) =>
                  commandNumberError(
                    project,
                    { type: 'fades', layerId: layer.id, opening: layer.openingFade, closing },
                    'Shorten the closing fade or adjust the last clip’s other fades/transitions.',
                  )
                }
                onCommit={(closing) =>
                  onEdit({ type: 'fades', layerId: layer.id, opening: layer.openingFade, closing })
                }
              />
            </label>
          </div>
        </section>
      </InspectorSection>
    </>
  );
}

export function Inspector({
  project,
  assets,
  selectedClipId,
  selectedLayerId,
  boundaryId,
  frame,
  drafting,
  section,
  onSection,
  onEdit,
  onPreview,
  onSeek,
  onPause,
  children,
}: Readonly<Props>) {
  const inspectorId = useId();
  const colourControlId = useId();
  const expansion = useInspectorExpansion();
  const layer = project.layers.find((item) => item.id === selectedLayerId);
  const clip = project.clips.find((item) => item.id === selectedClipId && item.layerId === selectedLayerId);
  const asset = assets.find((item) => item.id === clip?.mediaId);
  const position = project.clips.findIndex((item) => item.id === clip?.id);
  const layout = calculateLayout(project);
  const placed = layout.clips.find((item) => item.clip.id === clip?.id);
  const sourceFrame =
    placed && frame >= placed.start && frame < placed.end ? placed.retiming.sourceAt(frame - placed.start) : null;
  const clipRate = clip ? sourceRateAt(clip.speed, sourceFrame ?? clip.sourceIn) : 1;
  const speedRate = layer ? evaluateLayerSetting(layer, 'speed', frame, clipRate) : 1;
  const inputContext = `${project.id}:${layer?.id}:${clip?.id ?? 'row'}`;
  const startRestriction = clip ? clipStartRestriction(project, clip) : null;
  const startHint = placementHint(layer, startRestriction);
  const clipTimingError = (changes: Partial<Pick<VideoClip, 'sourceIn' | 'sourceOut'>>): string | null =>
    clipRangeError(project, clip, changes);

  return (
    <InspectorExpansionContext value={expansion}>
      <aside className="inspector-panel panel declutter-inspector" aria-label="Clip inspector">
        <InspectorTabs id={inspectorId} section={section} onSection={onSection} />
        <div
          role="tabpanel"
          id={`${inspectorId}-clip-panel`}
          aria-labelledby={`${inspectorId}-clip-tab`}
          hidden={section !== 'clip'}
        >
          <InspectorExpansionControls expansion={expansion} />
          {layer ? (
            <>
              {clip && asset && placed ? (
                <div className="selected-clip-name inspector-selection">
                  <Icon name="video" size={17} />
                  <strong title={asset.name}>{shortName(asset.name)}</strong>
                  <span>
                    Excerpt {position + 1} · {sourceSeconds(placed.duration)} · {layer.name}
                  </span>
                </div>
              ) : (
                <div className="selected-clip-name inspector-selection">
                  <Icon name="layers" size={17} />
                  <strong title={layer.name}>{layer.name}</strong>
                  <span title="Opacity edits this whole row. Select a clip for source, Colour and speed settings.">
                    Whole video row
                  </span>
                </div>
              )}
              {clip && asset && placed && (
                <InspectorSection
                  id="source"
                  title="Source range"
                  icon="start"
                  badge={sourceSeconds(clip.sourceOut - clip.sourceIn)}
                  modified={clip.sourceIn !== 0 || clip.sourceOut !== asset.metadata.frameCount}
                  help={
                    <HelpPopover label="Source timing">
                      <p id={`${colourControlId}-source-help`}>
                        Original recording frames; OUT is exclusive. Layer keyframes stay in project timeline time when
                        this source range changes.
                      </p>
                    </HelpPopover>
                  }
                >
                  <section className="source-range" aria-label="Source range">
                    <div className="section-label">
                      <span>{sourceSeconds(asset.metadata.frameCount)} original</span>
                      <span>{sourceFrame === null ? 'Playhead outside clip' : `Source frame ${sourceFrame}`}</span>
                    </div>
                    <div className="range-fields">
                      <label htmlFor={`${colourControlId}-in`}>
                        IN <output>{formatTimecode(clip.sourceIn)}</output>
                        <NumberField
                          id={`${colourControlId}-in`}
                          aria-label="Source IN frame"
                          aria-describedby={`${colourControlId}-source-help`}
                          min={0}
                          max={clip.sourceOut - 1}
                          integer
                          step={1}
                          value={clip.sourceIn}
                          disabled={drafting}
                          resetKey={inputContext}
                          validate={(sourceIn) => clipTimingError({ sourceIn })}
                          onCommit={(sourceIn) =>
                            onEdit({ type: 'trim', clipId: clip.id, sourceIn, sourceOut: clip.sourceOut })
                          }
                        />
                      </label>
                      <label htmlFor={`${colourControlId}-out`}>
                        OUT <output>{formatTimecode(clip.sourceOut)}</output>
                        <NumberField
                          id={`${colourControlId}-out`}
                          aria-label="Source OUT frame"
                          aria-describedby={`${colourControlId}-source-help`}
                          min={clip.sourceIn + 1}
                          max={Math.min(asset.metadata.frameCount, 2_147_483_647)}
                          integer
                          step={1}
                          value={clip.sourceOut}
                          disabled={drafting}
                          resetKey={inputContext}
                          validate={(sourceOut) => clipTimingError({ sourceOut })}
                          onCommit={(sourceOut) =>
                            onEdit({ type: 'trim', clipId: clip.id, sourceIn: clip.sourceIn, sourceOut })
                          }
                        />
                      </label>
                    </div>
                    <div className="range-availability" aria-label="Recoverable source footage">
                      <span>{sourceSeconds(clip.sourceIn)} before</span>
                      <span>{sourceSeconds(asset.metadata.frameCount - clip.sourceOut)} after</span>
                    </div>
                    <button
                      className="text-button restore-range"
                      disabled={drafting || (clip.sourceIn === 0 && clip.sourceOut === asset.metadata.frameCount)}
                      onClick={() =>
                        onEdit({ type: 'trim', clipId: clip.id, sourceIn: 0, sourceOut: asset.metadata.frameCount })
                      }
                    >
                      <Icon name="reset" size={13} />
                      Restore full recording
                    </button>
                  </section>
                </InspectorSection>
              )}
              <InspectorSection
                id="layer-opacity"
                title="Placement"
                icon="layers"
                help={
                  <HelpPopover label="Placement timing">
                    <p>
                      Move the selected excerpt to a video layer or edit its timeline start. With Ripple on, only the
                      first clip's anchor can be edited here; drag later clips to reorder. Other tracks, music and row
                      keyframes stay at their project times. Opacity is in Colour and affects the whole row.
                    </p>
                  </HelpPopover>
                }
              >
                <section className="layer-inspector" aria-label="Clip placement">
                  {clip && placed && (
                    <>
                      <label className="speed-field">
                        Video layer
                        <select
                          aria-label="Clip video layer"
                          disabled={drafting}
                          value={clip.layerId}
                          onChange={(event) => {
                            const plan = planTimelineDrop(
                              project,
                              { kind: 'clip', clipId: clip.id, grabFrame: 0 },
                              event.target.value,
                              placed.start,
                              false,
                              0,
                              frame,
                            );
                            if (plan.command) onEdit(plan.command);
                          }}
                        >
                          {project.layers.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="speed-field" title={startHint}>
                        Timeline start frame
                        <NumberField
                          aria-label="Clip timeline start"
                          min={0}
                          max={2_147_483_647}
                          integer
                          step={1}
                          disabled={drafting || startRestriction !== null}
                          value={placed.start}
                          resetKey={inputContext}
                          hint={startHint}
                          validate={(start) =>
                            commandNumberError(
                              project,
                              { type: 'place', clipId: clip.id, layerId: clip.layerId, start, index: position },
                              'Adjust this placement or the conflicting clips/transitions.',
                            )
                          }
                          onCommit={(start) =>
                            onEdit({ type: 'place', clipId: clip.id, layerId: clip.layerId, start, index: position })
                          }
                        />
                      </label>
                    </>
                  )}
                  {!clip && <p className="control-hint">Select an excerpt to edit its placement.</p>}
                </section>
              </InspectorSection>
              <InspectorSection
                id="speed"
                title="Speed"
                icon="speed"
                badge={`${speedRate.toFixed(2)}×`}
                modified={
                  speedRate !== 1 ||
                  hasLayerKeys(layer, 'speed') ||
                  (clip !== undefined && clip.speed.mode !== 'constant')
                }
                help={
                  <SpeedHelp
                    clip={clip ?? null}
                    keyed={hasLayerKeys(layer, 'speed')}
                    helpId={`${colourControlId}-speed-help`}
                  />
                }
              >
                <SpeedControls
                  project={project}
                  resetKey={project.id}
                  helpId={`${colourControlId}-speed-help`}
                  clip={clip ?? null}
                  layer={layer}
                  frame={frame}
                  projectDuration={layout.duration}
                  placedDuration={placed?.duration ?? null}
                  disabled={drafting}
                  sourceFrame={sourceFrame}
                  sourceFrameCount={asset?.metadata.frameCount ?? null}
                  onEdit={onEdit}
                  onPreview={onPreview}
                  onSeek={onSeek}
                  onPause={onPause}
                />
              </InspectorSection>
              <TransformSection
                project={project}
                clip={clip ?? null}
                sourceFrameCount={asset?.metadata.frameCount ?? 0}
                frame={frame}
                disabled={drafting}
                onEdit={onEdit}
                onSeek={onSeek}
              />
              <ColourSection
                layer={layer}
                clip={clip ?? null}
                frame={frame}
                resetKey={`${inputContext}:${frame}`}
                disabled={drafting}
                onEdit={onEdit}
                id={colourControlId}
              />
            </>
          ) : (
            <div className="inspector-empty">Select a video layer or clip in the timeline.</div>
          )}
        </div>
        <div
          role="tabpanel"
          id={`${inspectorId}-keyframes-panel`}
          aria-labelledby={`${inspectorId}-keyframes-tab`}
          hidden={section !== 'keyframes'}
        >
          {layer ? (
            <KeyframeControls
              project={project}
              layer={layer}
              frame={frame}
              duration={layout.duration}
              disabled={drafting}
              onEdit={onEdit}
            />
          ) : (
            <div className="inspector-empty">Select a video track for its shared points.</div>
          )}
        </div>
        <div
          role="tabpanel"
          id={`${inspectorId}-sequence-panel`}
          aria-labelledby={`${inspectorId}-sequence-tab`}
          hidden={section !== 'sequence'}
        >
          {layer ? (
            <SequenceControls
              project={project}
              layer={layer}
              assets={assets}
              boundaryId={boundaryId}
              layout={layout}
              drafting={drafting}
              onEdit={onEdit}
              id={colourControlId}
            />
          ) : (
            <div className="inspector-empty">Select a video track for its transitions and fades.</div>
          )}
        </div>
        <div
          role="tabpanel"
          id={`${inspectorId}-audio-panel`}
          aria-labelledby={`${inspectorId}-audio-tab`}
          hidden={section !== 'audio'}
        >
          <InspectorSection id="music" title="Music" icon="music" modified={project.music.length > 0}>
            {children}
          </InspectorSection>
        </div>
      </aside>
    </InspectorExpansionContext>
  );
}
