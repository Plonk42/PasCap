import { Fragment, memo, useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR, type ScalarColourSetting } from '../shared/colour.js';
import { adjustmentAt, gradeColourAt } from '../shared/grade.js';
import { activeLayerSetting, hasLayerKeys, isKeyframeFrame } from '../shared/keyframes.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument, Transition, VideoClip, VideoLayer } from '../shared/model.js';
import type { TimelineRange } from '../shared/rush-editing.js';
import { calculateLayout, transitionOffset, type PlacedClip, type TimelineLayout } from '../shared/timeline.js';
import { ColourCurvesSection, HslRangesSection } from './AdvancedColour.js';
import { adjustmentLabel } from './adjustment-ui.js';
import { TrackAnimationControls } from './AnimationControls.js';
import { AutoAdjust } from './AutoAdjust.js';
import { AutoWhiteBalance } from './AutoWhiteBalance.js';
import { ClipSourceRange } from './ClipSourceRange.js';
import { COLOUR_GROUPS, colourGroupResetCommands, colourResetCommands } from './colour-reset.js';
import { DetailSection } from './DetailControls.js';
import { shortName, sourceSeconds } from './display.js';
import { countOf } from './grade-clipboard.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import {
  InspectorExpansionContext,
  InspectorExpansionControls,
  InspectorSection,
  useInspectorExpansion,
  type ColourTarget,
  type InspectorMode,
  type InspectorSectionRequest,
  type InspectorSectionTarget,
} from './InspectorSection.js';
import { ColourKeyframeList } from './ColourKeyframeList.js';
import {
  adjustmentColourOwner,
  clipColourOwner,
  colourTarget,
  displayedColour,
  gradeSeekFrame,
  gradeValuePosition,
  isClipOwner,
  ownerNoun,
  ownerTarget,
  type ColourOwner,
} from './colour-owner.js';
import { KeyframeNavigationContext, useKeyframeNavigation, type KeyframeNavigation } from './keyframe-navigation.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { clipStartRestriction } from './layer-actions.js';
import { NumberField } from './NumberField.js';
import { PanelCollapseButton, type SidePanel } from './PanelToggle.js';
import { settingPresentation } from './setting-scope.js';
import { livePreview } from './live-preview.js';
import { LockedCue, RangeSettingControl, ResetButton } from './SettingValueControl.js';
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
  /** Clips selected together (Ctrl/Cmd-click); one clip's grade is edited only on its own. */
  selectedClipCount?: number;
  /** The ruler range, from which an adjustment can be created. */
  timeRange?: TimelineRange | null;
  /** The adjustments selected on the timeline; one is edited instead of the one at the playhead. */
  selectedAdjustmentIds?: readonly string[];
  selectedLayerId: string;
  boundaryId: string | null;
  frame: number;
  drafting: boolean;
  section: InspectorMode;
  onSection: (section: InspectorMode) => void;
  sectionRequest?: InspectorSectionRequest | null;
  onSelectBoundary: (leftId: string) => void;
  onEdit: (command: EditCommand | readonly EditCommand[]) => void;
  children?: ReactNode;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
  onCollapse: (panel: SidePanel) => void;
  collapseDisabled: boolean;
}

const NO_ADJUSTMENTS: readonly string[] = [];

const INSPECTOR_MODES: readonly { id: InspectorMode; label: string }[] = [
  { id: 'clip', label: 'Clip' },
  { id: 'colour', label: 'Colour' },
  { id: 'track', label: 'Track' },
  { id: 'audio', label: 'Audio' },
];

const SECTION_TITLES: Record<InspectorSectionTarget, string> = {
  colour: 'Colour',
  speed: 'Speed',
  transform: 'Transform',
  transition: 'Transitions',
};

/** Bring a section to the top of the Inspector panel, then its detail into view, without scrolling the workspace. */
function revealInPanel(section: Element, detail: Element | null): void {
  const panel = section.closest<HTMLElement>('.inspector-panel');
  if (!panel) return;
  const padding = Number.parseFloat(getComputedStyle(panel).scrollPaddingTop) || 0;
  panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top - padding;
  const overflow = (detail?.getBoundingClientRect().bottom ?? 0) - panel.getBoundingClientRect().bottom;
  if (overflow > 0) panel.scrollTop += overflow;
}

const TRANSITION_LABEL: Record<Transition['type'], string> = {
  cut: 'Cut',
  'fade-through-black': 'Fade through black',
  'cross-dissolve': 'Cross-dissolve',
  'fade-black-pause': 'Black pause',
};

function transitionTiming(item: Transition): string {
  if (item.type === 'cut') return '';
  return ` · ${sourceSeconds(item.type === 'fade-black-pause' ? item.pause : item.duration)}`;
}

/** Switching type keeps the visible fade length where both types have one. */
function transitionOfType(boundary: Transition, type: Transition['type']): Transition {
  const pair = { leftId: boundary.leftId, rightId: boundary.rightId };
  if (type === 'cut') return { ...pair, type, duration: 0 };
  const span = boundary.type === 'fade-black-pause' ? 2 * boundary.fade : boundary.duration || 30;
  if (type === 'fade-black-pause') return { ...pair, type, fade: Math.ceil(span / 2), pause: 15 };
  return { ...pair, type, duration: type === 'fade-through-black' ? Math.max(2, span) : span };
}

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
  if (!boundary || transitionOffset(boundary) !== 0) return false;
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
      <div className="inspector-tab-list" role="tablist" aria-label="Properties sections">
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
  layer: ColourOwner;
  frame: number;
  resetKey: string;
  disabled: boolean;
  onEdit: Props['onEdit'];
}

function settingState(layer: ColourOwner, setting: ScalarColourSetting, frame: number) {
  const keyed = hasLayerKeys(layer, setting);
  const active = activeLayerSetting(layer, setting, frame);
  return { keyed, active, editable: !keyed || (isKeyframeFrame(frame) && active) };
}

function SettingScope({ scope }: Readonly<{ scope: string }>) {
  return (
    <small className="layer-setting-kind" title={scope}>
      <span className="sr-only">{scope}</span>
    </small>
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
}: Readonly<LayerControlProps & { control: ColourControlDefinition; value: number; id: string }>) {
  const state = settingState(layer, control.key, frame);
  const { scope, hint } = settingPresentation({
    ...state,
    owner: ownerNoun(layer),
    label: control.label,
    frame,
  });
  const command = (nextValue: number): EditCommand =>
    state.keyed
      ? { type: 'layer-key-value', ...ownerTarget(layer), frame, setting: control.key, value: nextValue }
      : { type: 'colour', ...colourTarget(layer), colour: { ...layer.colour, [control.key]: nextValue } };
  const commit = (nextValue: number): void => {
    if (!disabled && state.editable) onEdit(command(nextValue));
  };
  return (
    <div className="colour-control layer-keyed-control" data-animated={state.keyed} data-key-at-playhead={state.active}>
      <RangeSettingControl
        setting={control.key}
        id={id}
        value={value}
        disabled={disabled || !state.editable}
        onCommit={commit}
        onDraft={(value) => livePreview(value === null ? null : command(value))}
        hint={hint}
        scope={<SettingScope scope={scope} />}
        locked={state.keyed && !state.active && <LockedCue />}
        exact={{ resetKey: `${resetKey}:${control.key}:${state.keyed ? 'key' : 'layer'}` }}
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

function ColourSection({
  project,
  layer,
  frame,
  duration,
  layout,
  assets,
  resetKey,
  disabled,
  onEdit,
  id,
  valueFrame = frame,
  playhead = frame,
}: Readonly<
  LayerControlProps & {
    project: ProjectDocument;
    duration: number;
    layout: TimelineLayout;
    assets: readonly MediaAsset[];
    id: string;
    /** Where the image evaluates the values, when it differs from the frame keyframes are captured at. */
    valueFrame?: number;
    /** The project frame at the playhead, where Auto analyses a clip grade. */
    playhead?: number;
  }
>) {
  const colour = gradeColourAt(layer, frame);
  const clipGrade = isClipOwner(layer);
  const noun = ownerNoun(layer);
  const animated = COLOUR_CONTROLS.some((control) => hasLayerKeys(layer, control.key));
  const resetCommands = colourResetCommands(layer, frame);
  const adjusted = COLOUR_CONTROLS.filter(
    (control) => colour[control.key] !== NEUTRAL_COLOUR[control.key] || hasLayerKeys(layer, control.key),
  ).length;
  const canReset = resetCommands.length > 0;
  const resetTitle = animated
    ? `Reset only the enabled settings of this ${noun}’s keyframe at the playhead. Other settings and keyframes stay unchanged.`
    : `Reset this ${noun}’s Colour. Keyframes stay unchanged.`;
  const reset = (): void => {
    if (disabled || !canReset) return;
    onEdit(resetCommands);
  };
  const pointAtFrame = layer.keyframes.find((key) => key.frame === frame);
  const occupied = pointAtFrame !== undefined && !pointAtFrame.reset;
  let defaultTitle =
    'Add a default keyframe here: every Colour setting returns to its default and holds until its next keyframe. Earlier frames keep their values.';
  if (pointAtFrame?.reset) defaultTitle = 'Remove the default keyframe at the playhead';
  else if (pointAtFrame)
    defaultTitle = 'A keyframe already exists at the playhead; move to another frame for a default keyframe';
  return (
    <InspectorSection
      id="colour"
      title="Colour"
      icon="colour"
      modified={adjusted > 0}
      help={
        <HelpPopover label="Colour animation" guide="colour-speed-and-keyframes">
          {clipGrade ? (
            <p>
              These settings grade this clip only, before any adjustment; its keyframes stay with its footage when you
              trim or move it.
            </p>
          ) : (
            <p>
              These settings grade every video track within this adjustment’s range, after each clip’s own grade; its
              keyframes move with it.
            </p>
          )}
          <p className="editor-help-tip">
            Tip: hold Original above the preview to see the image without Colour; with Shift only clip grades are
            bypassed, with Alt only adjustments.
          </p>
        </HelpPopover>
      }
    >
      <TrackAnimationControls
        label="Colour"
        layer={layer}
        frame={frame}
        settings={COLOUR_CONTROLS.map((control) => control.key)}
        disabled={disabled}
      >
        <button
          type="button"
          className="text-button"
          disabled={disabled || !canReset}
          aria-label="Reset colour"
          title={resetTitle}
          onClick={reset}
        >
          <Icon name="reset" size={13} />
          Reset
        </button>
        <button
          type="button"
          className="icon-button default-keyframe-button"
          disabled={disabled}
          aria-disabled={occupied || undefined}
          aria-pressed={pointAtFrame?.reset === true}
          aria-label={pointAtFrame?.reset ? 'Remove default keyframe' : 'Add default keyframe'}
          title={defaultTitle}
          onClick={() => {
            if (!occupied) onEdit([{ type: 'layer-key-default', ...ownerTarget(layer), frame }]);
          }}
        >
          <Icon name="default-key" size={16} />
        </button>
        {isClipOwner(layer) && (
          <AutoAdjust
            project={project}
            clipId={layer.gradeClipId}
            layout={layout}
            assets={assets}
            playhead={playhead}
            disabled={disabled}
            onEdit={onEdit}
          />
        )}
      </TrackAnimationControls>
      <div className="colour-controls">
        {COLOUR_GROUPS.map((group) => (
          <ColourGroup
            key={group.name}
            group={group}
            layer={layer}
            frame={frame}
            valueFrame={valueFrame}
            resetKey={resetKey}
            disabled={disabled}
            onEdit={onEdit}
            id={id}
            afterTint={
              isClipOwner(layer) && (
                <AutoWhiteBalance
                  project={project}
                  clipId={layer.gradeClipId}
                  layout={layout}
                  assets={assets}
                  playhead={playhead}
                  disabled={disabled}
                  onEdit={onEdit}
                />
              )
            }
          />
        ))}
      </div>
      <ColourKeyframeList
        project={project}
        layer={layer}
        frame={frame}
        duration={duration}
        disabled={disabled}
        onEdit={onEdit}
      />
    </InspectorSection>
  );
}

function ColourGroup({
  group,
  layer,
  frame,
  resetKey,
  disabled,
  onEdit,
  id,
  afterTint,
  valueFrame,
}: Readonly<
  LayerControlProps & { group: (typeof COLOUR_GROUPS)[number]; id: string; afterTint: ReactNode; valueFrame: number }
>) {
  const colour = displayedColour(layer, frame, valueFrame);
  const headingId = `${id}-group-${group.name.toLowerCase()}`;
  const neutral = group.settings.every((setting) => colour[setting] === NEUTRAL_COLOUR[setting]);
  const commands = colourGroupResetCommands(layer, frame, group.settings);
  let blocked: string | null = null;
  if (disabled) blocked = 'These settings cannot be edited right now.';
  else if (neutral) blocked = 'Already at their default values.';
  else if (commands.length === 0) blocked = 'Add keyframes to edit these settings before resetting them.';
  return (
    <fieldset className="colour-group" aria-labelledby={headingId}>
      <legend className="colour-group-heading">
        <span id={headingId}>{group.name}</span>
        <ResetButton name={`the ${group.name} group`} blocked={blocked} onReset={() => onEdit(commands)} />
      </legend>
      {group.settings.map((setting) => (
        <Fragment key={setting}>
          <ColourControl
            layer={layer}
            frame={frame}
            resetKey={resetKey}
            disabled={disabled}
            onEdit={onEdit}
            control={COLOUR_CONTROLS.find((item) => item.key === setting)!}
            value={colour[setting]}
            id={`${id}-${setting}`}
          />
          {setting === 'tint' && afterTint}
        </Fragment>
      ))}
    </fieldset>
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
  const [keepCutChosen, setKeepCutChosen] = useState(false);
  // Only a Ripple track moves its later clips when an overlap changes.
  const keepCut = layer.ripple && keepCutChosen;
  const setTransition = (transition: Transition): void => onEdit({ type: 'transition', transition, keepCut });
  const transitionError = (transition: Transition): string | null =>
    commandNumberError(
      project,
      { type: 'transition', transition, keepCut },
      'Shorten this transition or adjust conflicting fades/placements on this track.',
    );
  const resetKey = `${project.id}:${layer.id}:${boundary?.leftId}:${boundary?.rightId}:${boundary?.type}`;
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
                    {transitionTiming(item)}
                  </small>
                </button>
                {item === boundary && (
                  <section className="boundary-inspector" aria-label="Boundary transition">
                    <label className="transition-type">
                      <span>Type</span>
                      <select
                        aria-label="Transition type"
                        aria-describedby={transitionGap ? `${id}-transition-gap` : `${id}-transition-help`}
                        disabled={drafting}
                        value={boundary.type}
                        onChange={(event) =>
                          setTransition(transitionOfType(boundary, event.target.value as Transition['type']))
                        }
                      >
                        <option value="cut">Cut</option>
                        <option value="fade-through-black" disabled={transitionGap}>
                          Fade through black
                        </option>
                        <option value="fade-black-pause" disabled={transitionGap}>
                          Fade through black with pause
                        </option>
                        <option value="cross-dissolve" disabled={transitionGap}>
                          Cross-dissolve
                        </option>
                      </select>
                    </label>
                    {layer.ripple && (
                      <label
                        className="transition-keep-cut"
                        title="A dissolve lengthens both clips by half its overlap, so the change and the later clips stay where they are."
                      >
                        <input
                          type="checkbox"
                          checked={keepCutChosen}
                          disabled={drafting}
                          onChange={(event) => setKeepCutChosen(event.target.checked)}
                        />
                        <span>Keep the cut in place</span>
                      </label>
                    )}
                    {boundary.type === 'fade-black-pause' && (
                      <div className="range-fields">
                        <label>
                          Fade <small>frames · {sourceSeconds(boundary.fade)}</small>
                          <NumberField
                            aria-label="Transition fade duration"
                            aria-describedby={`${id}-transition-help`}
                            min={1}
                            max={2_147_483_647}
                            integer
                            step={1}
                            disabled={drafting}
                            value={boundary.fade}
                            resetKey={resetKey}
                            validate={(fade) => transitionError({ ...boundary, fade })}
                            onCommit={(fade) => setTransition({ ...boundary, fade })}
                          />
                        </label>
                        <label>
                          Pause <small>frames · {sourceSeconds(boundary.pause)}</small>
                          <NumberField
                            aria-label="Transition pause duration"
                            aria-describedby={`${id}-transition-help`}
                            min={1}
                            max={2_147_483_647}
                            integer
                            step={1}
                            disabled={drafting}
                            value={boundary.pause}
                            resetKey={resetKey}
                            validate={(pause) => transitionError({ ...boundary, pause })}
                            onCommit={(pause) => setTransition({ ...boundary, pause })}
                          />
                        </label>
                      </div>
                    )}
                    {(boundary.type === 'fade-through-black' || boundary.type === 'cross-dissolve') && (
                      <div className="range-fields">
                        <label>
                          Duration <small>frames · {sourceSeconds(boundary.duration)}</small>
                          <NumberField
                            aria-label="Transition duration"
                            aria-describedby={`${id}-transition-help`}
                            min={boundary.type === 'fade-through-black' ? 2 : 1}
                            max={2_147_483_647}
                            integer
                            step={1}
                            disabled={drafting}
                            value={boundary.duration}
                            resetKey={resetKey}
                            validate={(duration) => transitionError({ ...boundary, duration })}
                            onCommit={(duration) => setTransition({ ...boundary, duration })}
                          />
                        </label>
                      </div>
                    )}
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
            MM:SS:FF in the fields.
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

/** The Colour tab's target: the selected clip's own grade, or the adjustment at the playhead (arrow keys switch). */
function ColourTargetSwitch({
  target,
  clipAvailable,
  disabled,
  onTarget,
}: Readonly<{
  target: ColourTarget;
  clipAvailable: boolean;
  disabled: boolean;
  onTarget: (target: ColourTarget) => void;
}>) {
  const choose = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = target === 'clip' ? 'adjustment' : 'clip';
    if (next === 'clip' && !clipAvailable) return;
    onTarget(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-colour-target="${next}"]`)?.focus();
  };
  return (
    <div className="colour-target-switch" role="radiogroup" aria-label="Colour target">
      {(['clip', 'adjustment'] as const).map((option) => {
        const unavailable = option === 'clip' && !clipAvailable;
        let title = option === 'clip' ? 'Grade only the selected clip' : 'Grade every track over a stretch of the film';
        if (unavailable) title = 'Select a clip in the timeline to grade it';
        return (
          <button
            key={option}
            type="button"
            role="radio"
            data-colour-target={option}
            tabIndex={target === option ? 0 : -1}
            aria-checked={target === option}
            aria-label={option === 'clip' ? 'Clip grade' : 'Adjustment'}
            aria-disabled={unavailable || undefined}
            disabled={disabled}
            title={title}
            onClick={() => {
              if (!unavailable) onTarget(option);
            }}
            onKeyDown={choose}
          >
            {option === 'clip' ? 'Clip' : 'Adjustment'}
          </button>
        );
      })}
    </div>
  );
}

/** "01:12:05 – 01:20:00": an adjustment by its range, OUT exclusive. */
function rangeReason(project: ProjectDocument, start: number, end: number): string | null {
  return commandNumberError(
    project,
    { type: 'adjustment-add', adjustmentId: 'candidate', start, duration: end - start },
    'Choose a stretch without one.',
  );
}

/** Creates an adjustment over the ruler range or the selected clip's span; never over another one. */
function NewAdjustment({
  project,
  timeRange,
  placed,
  frame,
  disabled,
  onEdit,
  onSeek,
}: Readonly<{
  project: ProjectDocument;
  timeRange: TimelineRange | null;
  placed: PlacedClip | undefined;
  frame: number;
  disabled: boolean;
  onEdit: Props['onEdit'];
  onSeek: (frame: number) => void;
}>) {
  const create = (start: number, end: number): void => {
    onEdit({ type: 'adjustment-add', adjustmentId: crypto.randomUUID(), start, duration: end - start });
    if (frame < start || frame >= end) onSeek(start);
  };
  const choices = [
    {
      label: 'Over the selected range',
      range: timeRange && { start: timeRange.inFrame, end: timeRange.outFrame },
      missing: 'Drag on the time ruler to select a range first.',
    },
    {
      label: 'Over the selected clip',
      range: placed && { start: placed.start, end: placed.end },
      missing: 'Select a clip in the timeline first.',
    },
  ];
  return (
    <fieldset className="adjustment-create" aria-label="New adjustment">
      <legend>New adjustment: one grade for every track over a stretch of the film</legend>
      {choices.map(({ label, range, missing }) => {
        const reason = range ? rangeReason(project, range.start, range.end) : missing;
        return (
          <button
            key={label}
            type="button"
            className="text-button"
            disabled={disabled}
            aria-disabled={reason !== null || undefined}
            title={
              reason ??
              `Grade every track ${range ? adjustmentLabel({ start: range.start, duration: range.end - range.start }) : ''}`
            }
            onClick={() => {
              if (range && reason === null) create(range.start, range.end);
            }}
          >
            <Icon name="plus" size={13} />
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}

interface ColourTabProps {
  project: ProjectDocument;
  assets: MediaAsset[];
  /** The selected clip, when it is placed. */
  clip: VideoClip | undefined;
  placed: PlacedClip | undefined;
  asset: MediaAsset | undefined;
  clipLabel: string;
  selectedClipCount: number;
  frame: number;
  /** The source frame the selected clip shows at the playhead, or null off the clip. */
  sourceFrame: number | null;
  timeRange: TimelineRange | null;
  selectedAdjustmentIds: readonly string[];
  layout: TimelineLayout;
  drafting: boolean;
  resetKey: string;
  id: string;
  target: ColourTarget;
  onTarget: (target: ColourTarget) => void;
  onEdit: (command: EditCommand | readonly EditCommand[]) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onPause: () => void;
  onSeek: (frame: number) => void;
}

/** Why the Colour tab edits nothing while several clips or adjustments are selected, or null. */
function severalSelected(clips: number, adjustments: number, target: ColourTarget): string | null {
  const edit = 'select one to edit its grade. Paste grade sets the same grade on all of them.';
  if (!adjustments) return target === 'clip' && clips > 1 ? `${countOf(clips, 'clip')} are selected: ${edit}` : null;
  if (!clips) return adjustments > 1 ? `${countOf(adjustments, 'adjustment')} are selected: ${edit}` : null;
  return `${countOf(clips, 'clip')} and ${countOf(adjustments, 'adjustment')} are selected: ${edit}`;
}

/** A clip grade's source frame at the playhead, for keyframes, and where the image evaluates it; -1 off the clip. */
function gradeFrames(placed: PlacedClip | undefined, projectFrame: number, sourceFrame: number | null) {
  if (!placed || sourceFrame === null) return { frame: -1, valueFrame: -1 };
  return { frame: sourceFrame, valueFrame: gradeValuePosition(placed, projectFrame) };
}

/** Colour, HSL ranges and Colour curves for the selected clip's grade or the adjustment at the playhead. */
function ColourTab(props: Readonly<ColourTabProps>) {
  const { project, clip, placed, asset, drafting, onEdit, onPreview, onPause, onSeek } = props;
  const navigation = useKeyframeNavigation();
  const adjustments = props.selectedAdjustmentIds;
  const item = adjustments.length
    ? project.adjustments.find((candidate) => candidate.id === adjustments[0])
    : adjustmentAt(project.adjustments, props.frame);
  const target: ColourTarget = clip ? props.target : 'adjustment';
  const clipNavigation = useMemo<KeyframeNavigation | null>(
    () =>
      placed
        ? {
            ...navigation,
            inspection: null,
            duration: (asset?.metadata.frameCount ?? placed.clip.sourceOut) + 1,
            frameNoun: 'source frame',
            onSeekKeyframe: (_owner, source) => onSeek(gradeSeekFrame(placed, source)),
          }
        : null,
    [navigation, placed, asset, onSeek],
  );
  const itemNavigation = useMemo<KeyframeNavigation | null>(
    () =>
      item
        ? {
            ...navigation,
            inspection: null,
            duration: item.duration,
            frameNoun: 'frame in adjustment',
            onSeekKeyframe: (_owner, offset) => onSeek(item.start + Math.min(Math.max(offset, 0), item.duration - 1)),
          }
        : null,
    [navigation, item, onSeek],
  );
  const header = (icon: 'video' | 'colour', title: string, detail: ReactNode, actions?: ReactNode) => (
    <div className="selected-clip-name inspector-selection colour-target">
      <Icon name={icon} size={17} />
      <strong title={title}>{title}</strong>
      <span>{detail}</span>
      <ColourTargetSwitch
        target={target}
        clipAvailable={clip !== undefined}
        disabled={drafting}
        onTarget={props.onTarget}
      />
      {actions}
    </div>
  );
  const several = severalSelected(clip ? Math.max(1, props.selectedClipCount) : 0, adjustments.length, target);
  if (several) return <div className="inspector-empty">{several}</div>;
  if (target === 'adjustment' && !item)
    return (
      <>
        {header('colour', 'No adjustment', 'At the playhead')}
        <NewAdjustment
          project={project}
          timeRange={props.timeRange}
          placed={placed}
          frame={props.frame}
          disabled={drafting}
          onEdit={onEdit}
          onSeek={onSeek}
        />
      </>
    );
  const clipName = asset ? shortName(asset.name) : 'Unavailable recording';
  let owner: ColourOwner;
  let frame: number;
  let valueFrame: number;
  let ownerNavigation: KeyframeNavigation;
  let title: string;
  if (target === 'adjustment' && item) {
    owner = adjustmentColourOwner(item, `adjustment ${adjustmentLabel(item)}`);
    // Keyframes are captured only on the adjustment's own frames.
    frame = props.frame >= item.start && props.frame < item.start + item.duration ? props.frame - item.start : -1;
    valueFrame = frame;
    ownerNavigation = itemNavigation!;
    title = `Adjustment ${adjustmentLabel(item)}`;
  } else {
    owner = clipColourOwner(clip!, `${props.clipLabel} (${clipName})`);
    ({ frame, valueFrame } = gradeFrames(placed, props.frame, props.sourceFrame));
    ownerNavigation = clipNavigation!;
    title = clipName;
  }
  const resetKey = `${props.resetKey}:${owner.id}:${frame}`;
  return (
    <>
      {isClipOwner(owner)
        ? header('video', title, 'This clip only')
        : header(
            'colour',
            title,
            'Every track within this range',
            <button
              type="button"
              className="icon-button"
              disabled={drafting}
              aria-label="Delete adjustment"
              title="Delete this adjustment and its keyframes"
              onClick={() => onEdit({ type: 'adjustment-remove', adjustmentId: owner.id })}
            >
              <Icon name="trash" size={15} />
            </button>,
          )}
      <KeyframeNavigationContext.Provider value={ownerNavigation}>
        <ColourSection
          project={project}
          layer={owner}
          frame={frame}
          duration={ownerNavigation.duration}
          layout={props.layout}
          assets={props.assets}
          resetKey={resetKey}
          disabled={drafting}
          onEdit={onEdit}
          id={props.id}
          valueFrame={valueFrame}
          playhead={props.frame}
        />
      </KeyframeNavigationContext.Provider>
      <HslRangesSection
        key={`hsl:${project.id}:${owner.id}`}
        project={project}
        layer={owner}
        frame={frame}
        disabled={drafting}
        onEdit={onEdit}
        onPause={onPause}
        onPreview={onPreview}
      />
      <ColourCurvesSection
        key={`curves:${project.id}:${owner.id}`}
        project={project}
        layer={owner}
        frame={frame}
        disabled={drafting}
        onEdit={onEdit}
        onPause={onPause}
        onPreview={onPreview}
      />
    </>
  );
}

export const Inspector = memo(InspectorPanel);

function InspectorPanel({
  project,
  assets,
  selectedClipId,
  selectedClipCount = 0,
  timeRange = null,
  selectedAdjustmentIds = NO_ADJUSTMENTS,
  selectedLayerId,
  boundaryId,
  frame,
  drafting,
  section,
  onSection,
  sectionRequest,
  onSelectBoundary,
  onEdit,
  onPreview,
  onSeek,
  onPause,
  onCollapse,
  collapseDisabled,
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
    // A timeline marker or boundary opens the section that edits it, even if it was collapsed.
    if (!sectionRequest) return;
    const { section: target } = sectionRequest;
    setOpen(target, true);
    // Wait for the tab switch and expansion to lay out, then bring the whole section to the top.
    let frameId = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(() => {
        const element = globalThis.document
          .querySelector<HTMLElement>(`.inspector-panel [aria-label="${SECTION_TITLES[target]} section"]`)
          ?.closest('.inspector-section');
        // Colour starts from the header naming the clip or adjustment it edits.
        const top =
          target === 'colour' ? (element?.parentElement?.querySelector(':scope > .colour-target') ?? element) : element;
        if (element && top) revealInPanel(top, element.querySelector('[data-selected="true"]'));
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [sectionRequest]);
  const sourceFrame =
    placed && frame >= placed.start && frame < placed.end ? placed.retiming.sourceAt(frame - placed.start) : null;
  // The choice stays while other clips are selected, so a track being graded stays the target; a lazily mounted
  // panel honours the marker that opened it.
  const [colourTargetChoice, setColourTargetChoice] = useState<ColourTarget>(sectionRequest?.colourTarget ?? 'clip');
  useEffect(() => {
    if (sectionRequest?.colourTarget) setColourTargetChoice(sectionRequest.colourTarget);
  }, [sectionRequest]);
  const inputContext = `${project.id}:${layer?.id}:${clip?.id ?? 'row'}`;
  const startRestriction = clip ? clipStartRestriction(project, clip) : null;
  const startHint = startRestriction ?? undefined;

  return (
    <InspectorExpansionContext value={expansion}>
      <aside className="inspector-panel panel editor-inspector" aria-label="Properties">
        <InspectorTabs
          id={inspectorId}
          section={section}
          onSection={onSection}
          trailing={
            <>
              <InspectorExpansionControls
                expansion={expansion}
                tab={section}
                hidden={(section === 'clip' && !placed) || (section === 'track' && !layer)}
              />
              <PanelCollapseButton panel="inspector" disabled={collapseDisabled} onToggle={onCollapse} />
            </>
          }
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
              <SpeedControls
                project={project}
                resetKey={project.id}
                helpId={`${colourControlId}-speed-help`}
                clip={clip ?? null}
                frame={frame}
                placedDuration={placed?.duration ?? null}
                disabled={drafting}
                sourceFrame={sourceFrame}
                sourceFrameCount={asset?.metadata.frameCount ?? null}
                onEdit={onEdit}
                onPreview={onPreview}
                onSeek={onSeek}
                onPause={onPause}
              />
              <DetailSection
                key={`detail:${project.id}:${clip.id}`}
                project={project}
                clip={clip}
                disabled={drafting}
                onEdit={onEdit}
              />
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
                    <p className="editor-help-tip">Tip: Opacity is in the Track tab, with Transform.</p>
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
                </section>
              </InspectorSection>
            </>
          ) : (
            <div className="inspector-empty">
              {layer ? `Select a clip on ${layer.name} to edit it.` : 'Select a clip in the timeline.'}
            </div>
          )}
        </div>
        <div
          role="tabpanel"
          id={`${inspectorId}-colour-panel`}
          aria-labelledby={`${inspectorId}-colour-tab`}
          hidden={section !== 'colour'}
        >
          <ColourTab
            project={project}
            assets={assets}
            clip={clip && placed ? clip : undefined}
            placed={placed}
            asset={asset}
            clipLabel={`clip ${trackPosition + 1}`}
            selectedClipCount={selectedClipCount}
            frame={frame}
            sourceFrame={sourceFrame}
            timeRange={timeRange}
            selectedAdjustmentIds={selectedAdjustmentIds}
            layout={layout}
            drafting={drafting}
            resetKey={inputContext}
            id={colourControlId}
            target={colourTargetChoice}
            onTarget={setColourTargetChoice}
            onEdit={onEdit}
            onPreview={onPreview}
            onPause={onPause}
            onSeek={onSeek}
          />
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
              <TransformSection
                project={project}
                layer={layer}
                frame={frame}
                disabled={drafting}
                onEdit={onEdit}
                onSeek={onSeek}
              />
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
