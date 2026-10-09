import { useEffect, useId, type KeyboardEvent, type ReactNode } from 'react';
import { COLOUR_CONTROLS, isNeutralColour, NEUTRAL_COLOUR } from '../shared/colour.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { colourAt } from '../shared/composition.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys, type KeyframeSetting } from '../shared/keyframes.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument, Transition, VideoClip, VideoLayer } from '../shared/model.js';
import { calculateLayout, type TimelineLayout } from '../shared/timeline.js';
import { AdvancedColour } from './AdvancedColour.js';
import { TrackAnimationControls, useAnimationTools } from './AnimationControls.js';
import { ClipSourceRange } from './ClipSourceRange.js';
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
import { SpeedControls } from './SpeedControls.js';
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
  onSelectBoundary: (leftId: string) => void;
  onEdit: (command: EditCommand | readonly EditCommand[]) => void;
  children?: ReactNode;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
}

const INSPECTOR_MODES: readonly { id: InspectorMode; label: string }[] = [
  { id: 'clip', label: 'Clip' },
  { id: 'track', label: 'Track' },
  { id: 'audio', label: 'Audio' },
];

const TRANSITION_LABEL: Record<Transition['type'], string> = {
  cut: 'Cut',
  'fade-through-black': 'Fade through black',
  'cross-dissolve': 'Cross-dissolve',
};

function commandNumberError(project: ProjectDocument, command: EditCommand, recovery: string): string | null {
  try {
    applyCommand(project, command);
    return null;
  } catch (cause) {
    return `${cause instanceof Error ? cause.message : 'This timing is not valid.'} ${recovery}`;
  }
}

function trackScope(clips: number): string {
  if (clips === 0) return 'Applies to every clip added to this track';
  return clips === 1 ? 'Applies to the clip on this track' : `Applies to all ${clips} clips on this track`;
}

function transitionHasGap(boundary: Transition | undefined, layout: TimelineLayout): boolean {
  if (!boundary || boundary.type === 'cross-dissolve') return false;
  const left = layout.clips.find((item) => item.clip.id === boundary.leftId);
  const right = layout.clips.find((item) => item.clip.id === boundary.rightId);
  return !!left && !!right && left.end !== right.start;
}

function InspectorTabs({
  id,
  section,
  onSection,
  trailing,
}: Readonly<{ id: string; section: InspectorMode; onSection: Props['onSection']; trailing?: ReactNode }>) {
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
    <div className="panel-heading inspector-tabs">
      <div className="inspector-tab-list" role="tablist" aria-label="Inspector sections">
        {INSPECTOR_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="tab"
            id={`${id}-${mode.id}-tab`}
            data-inspector-mode={mode.id}
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
      {trailing}
    </div>
  );
}

interface LayerControlProps {
  layer: VideoLayer;
  frame: number;
  resetKey: string;
  disabled: boolean;
  onEdit: Props['onEdit'];
  animate?: boolean;
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
  animate,
}: Readonly<LayerControlProps & { id: string }>) {
  const state = settingState(layer, 'opacity', frame, true);
  const value = evaluateLayerSetting(layer, 'opacity', frame, layer.opacity);
  const { scope, hint } = settingPresentation({
    ...state,
    baseLabel: 'Track',
    label: 'Opacity',
    frame,
  });
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
        exact={{ resetKey: `${resetKey}:opacity:${state.keyed ? 'key' : 'layer'}` }}
        actions={
          animate && (
            <KeyframeToggle
              layer={layer}
              setting="opacity"
              label="Opacity"
              frame={frame}
              value={value}
              disabled={disabled}
              onEdit={onEdit}
            />
          )
        }
      />
    </div>
  );
}

type ColourControlDefinition = (typeof COLOUR_CONTROLS)[number];

function ColourControl({
  layer,
  frame,
  resetKey,
  disabled,
  onEdit,
  control,
  value,
  id,
  animate,
}: Readonly<LayerControlProps & { control: ColourControlDefinition; value: number; id: string }>) {
  const state = settingState(layer, control.key, frame, true);
  const { scope, hint } = settingPresentation({ ...state, baseLabel: 'Track', label: control.label, frame });
  const commit = (nextValue: number): void => {
    if (disabled || !state.editable) return;
    if (state.keyed) {
      onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: control.key, value: nextValue });
      return;
    }
    onEdit({ type: 'colour', layerId: layer.id, colour: { ...layer.colour, [control.key]: nextValue } });
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
        exact={{ resetKey: `${resetKey}:${control.key}:${state.keyed ? 'key' : 'layer'}` }}
        actions={
          animate && (
            <KeyframeToggle
              layer={layer}
              setting={control.key}
              label={control.label}
              frame={frame}
              value={value}
              disabled={disabled}
              onEdit={onEdit}
            />
          )
        }
      />
    </div>
  );
}

function ColourSection({
  layer,
  frame,
  resetKey,
  disabled,
  onEdit,
  id,
  project,
  onPause,
  onPreview,
}: Readonly<LayerControlProps & { id: string } & Pick<Props, 'project' | 'onPause' | 'onPreview'>>) {
  const colour = colourAt(layer, frame);
  const opacity = evaluateLayerSetting(layer, 'opacity', frame, layer.opacity);
  const animated =
    hasLayerKeys(layer, 'opacity') || COLOUR_CONTROLS.some((control) => hasLayerKeys(layer, control.key));
  const tools = useAnimationTools('colour', `${project.id}:${layer.id}`, animated);
  const resetCommands = colourResetCommands(layer, frame);
  const adjusted =
    COLOUR_CONTROLS.filter(
      (control) => colour[control.key] !== NEUTRAL_COLOUR[control.key] || hasLayerKeys(layer, control.key),
    ).length + Number(opacity !== 1 || hasLayerKeys(layer, 'opacity'));
  const canReset = resetCommands.length > 0;
  const resetTitle = animated
    ? 'Reset only the enabled Colour settings, including Opacity, at this shared keyframe. Other settings and keyframes stay unchanged.'
    : 'Reset this track’s Colour and Opacity. Keyframes stay unchanged.';
  const reset = (): void => {
    if (disabled || !canReset) return;
    onEdit(resetCommands);
  };
  return (
    <InspectorSection
      id="colour"
      title="Colour"
      icon="colour"
      modified={adjusted > 0 || !isNeutralColour(layer.colour)}
      actions={
        <TrackAnimationControls
          label="Colour"
          layer={layer}
          frame={frame}
          settings={['opacity', ...COLOUR_CONTROLS.map((control) => control.key)]}
          tools={tools}
          disabled={disabled}
        />
      }
      help={
        <HelpPopover label="Colour animation" guide="colour-speed-and-shared-video-track-keyframes">
          <p>These settings grade every clip on this track. To grade one clip differently, put it on its own track.</p>
          <p className="editor-help-tip">Tip: Compare shows the ungraded image.</p>
        </HelpPopover>
      }
    >
      <div className="grade-heading">
        <button
          type="button"
          className="text-button"
          disabled={disabled || !canReset}
          aria-label="Reset colour"
          title={resetTitle}
          onClick={reset}
        >
          <Icon name="reset" size={13} />
          {animated ? 'Reset keyframes' : 'Reset'}
        </button>
      </div>
      {tools.warning && (
        <p className="control-hint">
          Animation tools cannot be saved in this browser; the choice remains available for this session.
        </p>
      )}
      <div className="colour-controls">
        <OpacityControl
          animate={tools.enabled}
          layer={layer}
          frame={frame}
          resetKey={resetKey}
          disabled={disabled}
          onEdit={onEdit}
          id={`${id}-opacity`}
        />
        {COLOUR_CONTROLS.map((control) => (
          <ColourControl
            animate={tools.enabled}
            key={control.key}
            layer={layer}
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
      <AdvancedColour
        key={`${project.id}:${layer.id}`}
        project={project}
        layer={layer}
        frame={frame}
        disabled={disabled}
        onEdit={onEdit}
        onPause={onPause}
        onPreview={onPreview}
      />
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
  onSelectBoundary,
  id,
}: Readonly<
  Pick<Props, 'project' | 'assets' | 'boundaryId' | 'drafting' | 'onEdit' | 'onSelectBoundary'> & {
    layer: VideoLayer;
    layout: TimelineLayout;
    id: string;
  }
>) {
  const boundary = layer.transitions.find((item) => item.leftId === boundaryId);
  const trackClips = layout.clips.filter((item) => item.clip.layerId === layer.id);
  const transitionGap = transitionHasGap(boundary, layout);
  const clipName = (clipId: string): string =>
    shortName(assets.find((item) => item.id === project.clips.find((clip) => clip.id === clipId)?.mediaId)?.name ?? '');
  const setTransition = (type: Transition['type'], duration: number): void => {
    if (!boundary) return;
    const pair = { leftId: boundary.leftId, rightId: boundary.rightId };
    if (type === 'cut') onEdit({ type: 'transition', transition: { ...pair, type, duration: 0 } });
    else onEdit({ type: 'transition', transition: { ...pair, type, duration } });
  };
  return (
    <>
      {layer.transitions.length > 0 && (
        <InspectorSection
          id="transition"
          title="Transitions"
          icon="split"
          badge={layer.transitions.length}
          modified={layer.transitions.some((item) => item.type !== 'cut')}
          help={
            <HelpPopover label="Transition timing" guide="assemble-trim-and-cut">
              <p id={`${id}-transition-help`}>
                A transition blends one clip into the next on this track. Fades and dissolves need the two clips to
                touch, so close any gap or turn Ripple on first.
              </p>
              <p className="editor-help-tip">
                Tip: if a change is refused, check the neighbouring fades and transitions.
              </p>
            </HelpPopover>
          }
        >
          <ol className="boundary-list" aria-label={`Transitions on ${layer.name}`}>
            {layer.transitions.map((item) => (
              <li key={`${item.leftId}:${item.rightId}`} data-selected={item === boundary}>
                <button
                  type="button"
                  className="boundary-choice"
                  aria-pressed={item === boundary}
                  disabled={drafting}
                  onClick={() => onSelectBoundary(item.leftId)}
                >
                  <span>
                    {clipName(item.leftId)} <Icon name="arrow" size={12} /> {clipName(item.rightId)}
                  </span>
                  <small>
                    {TRANSITION_LABEL[item.type]}
                    {item.type === 'cut' ? '' : ` · ${sourceSeconds(item.duration)}`}
                  </small>
                </button>
                {item === boundary && (
                  <section className="boundary-inspector" aria-label="Boundary transition">
                    <div className="transition-fields">
                      <label>
                        <span>Type</span>
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
                        Duration <small>frames · {sourceSeconds(boundary.duration)}</small>
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
                        These clips have a gap. Close it, or turn on Ripple for this track, before adding a fade or
                        dissolve.
                      </p>
                    )}
                  </section>
                )}
              </li>
            ))}
          </ol>
        </InspectorSection>
      )}
      <InspectorSection
        id="fades"
        title="Fades"
        icon="start"
        modified={layer.openingFade > 0 || layer.closingFade > 0}
        help={
          <HelpPopover label="Fade timing" guide="assemble-trim-and-cut">
            <p id={`${id}-fades-help`}>
              The opening fade darkens the start of this track’s first clip and the closing fade its last clip’s end, in
              timeline frames. 0 disables a fade.
            </p>
            <p className="editor-help-tip">Tip: fades darken this track only, so other tracks stay visible.</p>
          </HelpPopover>
        }
      >
        <section className="edge-fade-settings" aria-label="Sequence fades">
          <div className="range-fields">
            <label>
              Opening <small>frames · {sourceSeconds(layer.openingFade)}</small>
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
              Closing <small>frames · {sourceSeconds(layer.closingFade)}</small>
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

function SourceRangeSection({
  project,
  clip,
  asset,
  frame,
  drafting,
  resetKey,
  id,
  onEdit,
  onPreview,
  onPause,
}: Readonly<
  Pick<Props, 'project' | 'drafting' | 'onEdit' | 'onPreview' | 'onPause' | 'frame'> & {
    clip: VideoClip;
    asset: MediaAsset;
    resetKey: string;
    id: string;
  }
>) {
  const frameCount = asset.metadata.frameCount;
  return (
    <InspectorSection
      id="source"
      title="Range"
      icon="start"
      modified={clip.sourceIn !== 0 || clip.sourceOut !== frameCount}
      help={
        <HelpPopover label="Source timing" guide="assemble-trim-and-cut">
          <p id={`${id}-source-help`}>
            The bar shows the whole recording; drag IN and OUT to keep only the part you want. Type a frame number or
            HH:MM:SS:FF in the fields.
          </p>
          <p className="editor-help-tip">Tip: Restore full recording undoes a trim.</p>
        </HelpPopover>
      }
    >
      <ClipSourceRange
        key={resetKey}
        project={project}
        clip={clip}
        count={frameCount}
        frame={frame}
        disabled={drafting}
        resetKey={resetKey}
        id={id}
        onEdit={onEdit}
        onPreview={onPreview}
        onPause={onPause}
      />
    </InspectorSection>
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
  onSelectBoundary,
  onEdit,
  onPreview,
  onSeek,
  onPause,
  children,
}: Readonly<Props>) {
  const inspectorId = useId();
  const colourControlId = useId();
  const expansion = useInspectorExpansion();
  const { setOpen } = expansion;
  const layer = project.layers.find((item) => item.id === selectedLayerId);
  const clip = project.clips.find((item) => item.id === selectedClipId && item.layerId === selectedLayerId);
  const asset = assets.find((item) => item.id === clip?.mediaId);
  const layout = calculateLayout(project);
  const placed = layout.clips.find((item) => item.clip.id === clip?.id);
  const trackClips = layout.clips.filter((item) => item.clip.layerId === layer?.id);
  const position = project.clips.findIndex((item) => item.id === clip?.id);
  const trackPosition = trackClips.findIndex((item) => item.clip.id === clip?.id);
  useEffect(() => {
    // A timeline boundary click must reveal its transition even if the section was collapsed.
    if (boundaryId !== null && section === 'track') setOpen('transition', true);
  }, [boundaryId, section]);
  const sourceFrame =
    placed && frame >= placed.start && frame < placed.end ? placed.retiming.sourceAt(frame - placed.start) : null;
  const inputContext = `${project.id}:${layer?.id}:${clip?.id ?? 'row'}`;
  const startRestriction = clip ? clipStartRestriction(project, clip) : null;
  const startHint = startRestriction ?? undefined;
  const earlierTitle =
    placed?.start === 0 ? 'Already at timeline frame 0' : 'Move this start or first Ripple anchor · Alt+Left';
  const nudgeClip = (delta: number): void => {
    if (clip && placed)
      onEdit({ type: 'place', clipId: clip.id, layerId: clip.layerId, start: placed.start + delta, index: position });
  };

  return (
    <InspectorExpansionContext value={expansion}>
      <aside className="inspector-panel panel declutter-inspector" aria-label="Clip inspector">
        <InspectorTabs
          id={inspectorId}
          section={section}
          onSection={onSection}
          trailing={<InspectorExpansionControls expansion={expansion} hidden={section !== 'clip' || !placed} />}
        />
        <div
          role="tabpanel"
          id={`${inspectorId}-clip-panel`}
          aria-labelledby={`${inspectorId}-clip-tab`}
          hidden={section !== 'clip'}
        >
          {layer && clip && placed ? (
            <>
              <div className="selected-clip-name inspector-selection">
                <Icon name="video" size={17} />
                <strong title={asset?.name}>{asset ? shortName(asset.name) : 'Unavailable recording'}</strong>
                <span>
                  Clip {trackPosition + 1} of {trackClips.length} · {layer.name}
                </span>
              </div>
              {asset && (
                <SourceRangeSection
                  project={project}
                  clip={clip}
                  asset={asset}
                  frame={frame}
                  drafting={drafting}
                  resetKey={inputContext}
                  id={colourControlId}
                  onEdit={onEdit}
                  onPreview={onPreview}
                  onPause={onPause}
                />
              )}
              <InspectorSection
                id="layer-opacity"
                title="Placement"
                icon="layers"
                help={
                  <HelpPopover label="Placement timing" guide="assemble-trim-and-cut">
                    <p>
                      Choose the track and timeline start for this clip. With Ripple on, only the first clip's start can
                      be typed; drag the others to reorder.
                    </p>
                    <p className="editor-help-tip">Tip: Opacity is in Track → Colour.</p>
                  </HelpPopover>
                }
              >
                <section className="layer-inspector" aria-label="Clip placement">
                  {clip && placed && (
                    <>
                      <label className="speed-field">
                        <span>Video track</span>
                        <select
                          aria-label="Clip video track"
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
                          {...(startHint ? { hint: startHint } : {})}
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
                      <div className="clip-nudge-controls">
                        <button
                          type="button"
                          className="secondary-button small"
                          aria-label="Move clip one frame earlier"
                          title={startRestriction ?? earlierTitle}
                          disabled={drafting || startRestriction !== null || placed.start === 0}
                          onClick={() => nudgeClip(-1)}
                        >
                          ← 1 frame
                        </button>
                        <button
                          type="button"
                          className="secondary-button small"
                          aria-label="Move clip one frame later"
                          title={startRestriction ?? 'Move this start or first Ripple anchor · Alt+Right'}
                          disabled={drafting || startRestriction !== null}
                          onClick={() => nudgeClip(1)}
                        >
                          1 frame →
                        </button>
                      </div>
                    </>
                  )}
                </section>
              </InspectorSection>
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
              <TransformSection
                project={project}
                clip={clip ?? null}
                sourceFrameCount={asset?.metadata.frameCount ?? 0}
                frame={frame}
                disabled={drafting}
                onEdit={onEdit}
                onSeek={onSeek}
              />
            </>
          ) : (
            <div className="inspector-empty">
              {layer ? `Select a clip on ${layer.name} to edit it.` : 'Select a clip in the timeline.'}
            </div>
          )}
        </div>
        <div
          role="tabpanel"
          id={`${inspectorId}-track-panel`}
          aria-labelledby={`${inspectorId}-track-tab`}
          hidden={section !== 'track'}
        >
          {layer ? (
            <>
              <div className="selected-clip-name inspector-selection">
                <Icon name="layers" size={17} />
                <strong title={layer.name}>{layer.name}</strong>
                <span>{trackScope(trackClips.length)}</span>
              </div>
              <ColourSection
                project={project}
                onPause={onPause}
                onPreview={onPreview}
                layer={layer}
                frame={frame}
                resetKey={`${inputContext}:${frame}`}
                disabled={drafting}
                onEdit={onEdit}
                id={colourControlId}
              />
              <InspectorSection
                id="keyframes"
                title="Keyframes"
                icon="curve"
                badge={layer.keyframes.length || undefined}
                modified={layer.keyframes.length > 0}
              >
                <KeyframeControls
                  project={project}
                  layer={layer}
                  frame={frame}
                  duration={layout.duration}
                  disabled={drafting}
                  onEdit={onEdit}
                />
              </InspectorSection>
              <SequenceControls
                project={project}
                layer={layer}
                assets={assets}
                boundaryId={boundaryId}
                layout={layout}
                drafting={drafting}
                onEdit={onEdit}
                onSelectBoundary={onSelectBoundary}
                id={colourControlId}
              />
            </>
          ) : (
            <div className="inspector-empty">Select a video track in the timeline.</div>
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
