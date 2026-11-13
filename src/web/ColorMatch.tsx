import { useEffect, useId, useRef, useState } from 'react';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import type { TimelineLayout } from '../shared/timeline.js';
import { formatTimecode } from '../shared/timing.js';
import {
  analysisKey,
  analyzeMatch,
  animatedInParts,
  cachedMatch,
  initialApply,
  keyframeReason,
  likenessNote,
  matchCommands,
  matchParts,
  referenceAtPlayhead,
  referenceThumbnail,
  rememberMatch,
  resolveReference,
  type MatchApply,
  type MatchContext,
  type MatchPart,
  type MatchResults,
  type ResolvedReference,
} from './color-match.js';
import { sameReference, setColorReference, useColorReference, type ColorReference } from './color-reference.js';
import { settingLabel } from './auto-adjust.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { livePreview } from './live-preview.js';
import { Popover } from './Popover.js';
import { ResetLabel } from './SettingValueControl.js';
import { referencesLabel, useStyles } from './styles.js';
import { StylesDialog } from './StylesDialog.js';
import { ValueControl } from './ValueControl.js';
import './color-match.css';

interface Props {
  project: ProjectDocument;
  layout: TimelineLayout;
  assets: readonly MediaAsset[];
  playhead: number;
  /** The selected clips: each takes the match, at the playhead or at its middle frame. */
  clipIds: readonly string[];
  disabled: boolean;
  onEdit: (commands: readonly EditCommand[]) => void;
}

/** Color → Match: grades the selected clips so they look like a reference frame or a registered style. */
export function ColorMatchSection(props: Readonly<Props>) {
  return (
    <InspectorSection
      id="match"
      title="Match"
      icon="wand"
      help={
        <HelpPopover label="Match" guide="match-colors-to-a-reference">
          <p>
            Grades the selected clips so they look like a reference: a timeline frame as its grade shows it, a recording
            frame as shot (from Source preview), or one of your registered styles.
          </p>
          <p>
            Each clip is matched at the frame under the playhead, or at its middle frame. Frames of the same scene are
            matched picture to picture; other scenes take the reference’s light and look.
          </p>
        </HelpPopover>
      }
    >
      <ColorMatch {...props} />
    </InspectorSection>
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'analyzing'; key: string; done: number; total: number }
  | { kind: 'failed'; key: string; message: string }
  | { kind: 'ready'; key: string; results: MatchResults };

function ColorMatch({ project, layout, assets, playhead, clipIds, disabled, onEdit }: Readonly<Props>) {
  const id = useId();
  const reference = useColorReference(project.id);
  const [menuOpen, setMenuOpen] = useState(false);
  // The registry is read only when a style can be chosen or is the reference.
  const styles = useStyles(menuOpen || reference?.kind === 'style');
  const [managing, setManaging] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const context: MatchContext = { project, layout, assets, playhead, clipIds };
  const resolved = resolveReference(reference, context, styles);
  const parts = matchParts(context, resolved.value);
  const analysis = useMatchAnalysis(project.id, resolved.value, parts.value, setAnnouncement);
  const count = parts.value?.length ?? 0;
  const blocked = disabled ? 'Color cannot be edited right now.' : (resolved.reason ?? parts.reason);
  return (
    <div className="color-match" data-phase={analysis.phase?.kind ?? 'idle'}>
      <ReferenceCard
        projectId={project.id}
        reference={reference}
        resolved={resolved.value}
        reason={resolved.reason}
        context={context}
        styles={styles}
        disabled={disabled}
        onMenu={setMenuOpen}
        onManageStyles={() => setManaging(true)}
      />
      <p className="color-match-target">{targetLabel(parts.value, layout, clipIds.length)}</p>
      <MatchProgress
        id={id}
        phase={analysis.phase}
        count={count}
        blocked={blocked}
        onStart={() => {
          if (!disabled) analysis.start();
        }}
        onCancel={analysis.cancel}
      />
      {analysis.phase?.kind === 'ready' && resolved.value && parts.value && (
        <MatchResult
          project={project}
          reference={resolved.value}
          parts={parts.value}
          results={analysis.phase.results}
          disabled={disabled}
          onApply={(commands, message) => {
            onEdit(commands);
            analysis.cancel();
            setAnnouncement(message);
          }}
          onCancel={analysis.cancel}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {managing && <StylesDialog onClose={() => setManaging(false)} />}
    </div>
  );
}

/**
 * The match of the current reference and parts: idle until started, then analyzing, failed or ready. A new reference,
 * clip or frame is a new match: it cancels the old analysis, and with it the preview.
 */
function useMatchAnalysis(
  projectId: string,
  reference: ResolvedReference | null,
  parts: readonly MatchPart[] | null,
  announce: (message: string) => void,
): { phase: Exclude<Phase, { kind: 'idle' }> | null; start: () => void; cancel: () => void } {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const key = reference && parts ? analysisKey(reference, parts) : null;
  useEffect(() => {
    if (phase.kind !== 'idle' && phase.key !== key) setPhase({ kind: 'idle' });
  }, [key, phase]);
  const analyzing = phase.kind === 'analyzing' && phase.key === key ? key : null;
  useEffect(() => {
    if (analyzing === null || !reference || !parts) return;
    const abort = new AbortController();
    analyzeMatch(reference, parts, abort.signal, (done, total) => {
      if (!abort.signal.aborted) setPhase({ kind: 'analyzing', key: analyzing, done, total });
    }).then(
      (results) => {
        if (abort.signal.aborted) return;
        rememberMatch(projectId, analyzing, results);
        setPhase({ kind: 'ready', key: analyzing, results });
        announce('The match is previewed. Choose an Intensity, then Apply.');
      },
      (cause: unknown) => {
        if (abort.signal.aborted) return;
        setPhase({ kind: 'failed', key: analyzing, message: cause instanceof Error ? cause.message : 'Match failed.' });
      },
    );
    return () => abort.abort();
    // Progress updates the phase of the same key without restarting the analysis.
  }, [analyzing]);
  return {
    phase: phase.kind !== 'idle' && phase.key === key ? phase : null,
    start: () => {
      if (key === null) return;
      announce('');
      const cached = cachedMatch(projectId, key);
      setPhase(cached ? { kind: 'ready', key, results: cached } : { kind: 'analyzing', key, done: 0, total: 0 });
    },
    cancel: () => setPhase({ kind: 'idle' }),
  };
}

/** A previewed match: its Intensity and how it applies, in one Undo step. */
function MatchResult({
  project,
  reference,
  parts,
  results,
  disabled,
  onApply,
  onCancel,
}: Readonly<{
  project: ProjectDocument;
  reference: ResolvedReference;
  parts: readonly MatchPart[];
  results: MatchResults;
  disabled: boolean;
  onApply: (commands: readonly EditCommand[], message: string) => void;
  onCancel: () => void;
}>) {
  const id = useId();
  const [percent, setPercent] = useState(100);
  const [draft, setDraft] = useState<number | null>(null);
  const [applyAs, setApplyAs] = useState<MatchApply>(() => initialApply(project, parts));
  const keyframeBlocked = keyframeReason(project, parts);
  const apply = keyframeBlocked === null ? applyAs : 'values';
  const commandsAt = (value: number): EditCommand[] => matchCommands(project, parts, results, apply, value / 100);
  // Re-issued when the committed project changes too, since that replaces the preview.
  useEffect(() => {
    livePreview(commandsAt(draft ?? percent));
  }, [results, project, draft, percent, apply]);
  useEffect(() => () => livePreview(null), []);
  // Match gave way to the result: show its Apply, and keep the keyboard there.
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = actions.current;
    if (!element) return;
    element.scrollIntoView({ block: 'nearest' });
    const focused = element.ownerDocument.activeElement;
    if (focused === null || focused === element.ownerDocument.body)
      element.querySelector('button')?.focus({ preventScroll: true });
  }, []);
  const animated = apply === 'values' ? animatedInParts(project, parts) : [];
  const commands = commandsAt(percent);
  return (
    <div className="color-match-result">
      <p className="color-match-note">{likenessNote(results, reference)}</p>
      <div className="color-control color-match-intensity">
        <span>
          <ResetLabel
            htmlFor={id}
            name="match intensity"
            blocked={percent === 100 ? 'Already at its default value.' : null}
            onReset={() => setPercent(100)}
          >
            Intensity
          </ResetLabel>
        </span>
        <ValueControl
          id={id}
          aria-label="Match intensity"
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
          How far each clip moves from its grade to the match: 100% applies the match.
        </span>
      </div>
      {parts.length === 1 && <ApplyAs id={id} apply={apply} keyframeBlocked={keyframeBlocked} onChange={setApplyAs} />}
      {animated.length > 0 && (
        <p className="color-match-scope">
          Animated, not changed: {animated.map((setting) => settingLabel(setting)).join(', ')}.
        </p>
      )}
      <div className="color-match-actions" ref={actions}>
        <button
          type="button"
          className="primary-button small"
          aria-disabled={commands.length === 0 || disabled || undefined}
          title={
            commands.length === 0 ? 'Every setting Match sets is animated: key it at the playhead instead.' : undefined
          }
          onClick={() => {
            if (disabled || !commands.length) return;
            onApply(
              commands,
              apply === 'keyframe' ? `Match keyframed at ${percent}%.` : `Match applied at ${percent}%.`,
            );
          }}
        >
          {parts.length > 1 ? `Apply to ${parts.length} clips` : 'Apply'}
        </button>
        <button type="button" className="secondary-button small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Match, its progress or its failure, before a result is previewed. */
function MatchProgress({
  id,
  phase,
  count,
  blocked,
  onStart,
  onCancel,
}: Readonly<{
  id: string;
  phase: Phase | null;
  count: number;
  blocked: string | null;
  onStart: () => void;
  onCancel: () => void;
}>) {
  if (phase?.kind === 'analyzing')
    return (
      <div className="color-match-actions">
        <output className="color-match-progress">
          {phase.total ? `Analyzing ${phase.done}/${phase.total} frames…` : 'Analyzing…'}
        </output>
        <button type="button" className="secondary-button small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  if (phase?.kind === 'failed')
    return (
      <div className="color-match-actions">
        <p className="color-match-error" role="alert">
          {phase.message}
        </p>
        <button type="button" className="secondary-button small" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  if (phase) return null;
  return (
    <div className="color-match-actions">
      <button
        type="button"
        className="primary-button small"
        aria-disabled={blocked !== null || undefined}
        aria-describedby={blocked ? `${id}-blocked` : undefined}
        title={blocked ?? 'Analyze the frames and preview the match'}
        onClick={onStart}
      >
        <Icon name="wand" size={13} />
        {count > 1 ? `Match ${count} clips` : 'Match'}
      </button>
      {blocked && (
        <span id={`${id}-blocked`} className="color-match-reason">
          {blocked}
        </span>
      )}
    </div>
  );
}

function ApplyAs({
  id,
  apply,
  keyframeBlocked,
  onChange,
}: Readonly<{ id: string; apply: MatchApply; keyframeBlocked: string | null; onChange: (apply: MatchApply) => void }>) {
  return (
    <fieldset className="color-match-apply">
      <legend>Apply as</legend>
      <label>
        <input type="radio" name={`${id}-apply`} checked={apply === 'values'} onChange={() => onChange('values')} />
        <span>Grade values</span>
      </label>
      <label title={keyframeBlocked ?? undefined}>
        <input
          type="radio"
          name={`${id}-apply`}
          checked={apply === 'keyframe'}
          disabled={keyframeBlocked !== null}
          onChange={() => onChange('keyframe')}
        />
        <span>Keyframe at playhead</span>
      </label>
    </fieldset>
  );
}

/** "This clip at the playhead (00:12:05)", or how the selected clips are matched. */
function targetLabel(parts: readonly MatchPart[] | null, layout: TimelineLayout, selected: number): string {
  if (!parts) return selected > 1 ? `${selected} selected clips` : 'This clip';
  if (parts.length > 1) return `${parts.length} selected clips, each at the playhead or at its middle frame`;
  const [part] = parts;
  const frame = part!.clip.start + part!.offset;
  const at = formatTimecode(Math.min(frame, layout.duration - 1));
  return part!.atPlayhead ? `This clip at the playhead (${at})` : `This clip at its middle frame (${at})`;
}

function ReferenceCard({
  projectId,
  reference,
  resolved,
  reason,
  context,
  styles,
  disabled,
  onMenu,
  onManageStyles,
}: Readonly<{
  projectId: string;
  reference: ColorReference | null;
  resolved: ResolvedReference | null;
  reason: string | null;
  context: MatchContext;
  styles: ReturnType<typeof useStyles>;
  disabled: boolean;
  onMenu: (open: boolean) => void;
  onManageStyles: () => void;
}>) {
  const atPlayhead = referenceAtPlayhead(context);
  const choose = (next: ColorReference | null): void => {
    setColorReference(projectId, next);
  };
  const playheadTitle =
    atPlayhead.reason ??
    (sameReference(atPlayhead.value, reference)
      ? 'This frame is already the reference'
      : 'Use the frame shown at the playhead, as its grade shows it, as the reference');
  return (
    <fieldset className="color-match-reference">
      <legend>Reference</legend>
      <ReferenceImage resolved={resolved} />
      <div className="color-match-reference-text">
        <strong title={resolved?.label}>{resolved?.label ?? 'No reference'}</strong>
        <span>{resolved?.detail ?? (reference ? reason : 'Choose the look to match')}</span>
      </div>
      <div className="color-match-reference-actions">
        <button
          type="button"
          className="secondary-button small"
          aria-label="Use the frame at the playhead as the color reference"
          title={playheadTitle}
          aria-disabled={disabled || atPlayhead.value === null || undefined}
          onClick={() => {
            if (!disabled && atPlayhead.value) choose(atPlayhead.value);
          }}
        >
          Use playhead frame
        </button>
        <Popover
          label="Styles and other references"
          title="Match to one of your registered styles, or clear the reference"
          className="color-match-more"
          onOpenChange={onMenu}
          trigger={
            <>
              Styles
              <Icon name="chevron-down" size={12} />
            </>
          }
        >
          {(close) => (
            <div className="color-match-menu">
              <p className="color-match-hint">
                A recording frame: open the recording in Source preview, then choose <b>Use as reference</b>.
              </p>
              <fieldset>
                <legend>Styles</legend>
                {styles.length === 0 && <p className="color-match-hint">No style registered yet.</p>}
                {styles.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    className="text-button"
                    aria-pressed={reference?.kind === 'style' && reference.styleId === style.id}
                    title={`Match to ${style.name}, measured on ${referencesLabel(style)}`}
                    onClick={() => {
                      choose({ kind: 'style', styleId: style.id });
                      close();
                    }}
                  >
                    {style.name}
                    <small>{referencesLabel(style)}</small>
                  </button>
                ))}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    close();
                    onManageStyles();
                  }}
                >
                  Manage styles…
                </button>
              </fieldset>
              {reference && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    choose(null);
                    close();
                  }}
                >
                  Clear reference
                </button>
              )}
            </div>
          )}
        </Popover>
      </div>
    </fieldset>
  );
}

/** The reference frame as graded, or a style's swatch. */
function ReferenceImage({ resolved }: Readonly<{ resolved: ResolvedReference | null }>) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!resolved || resolved.kind === 'style') return;
    const abort = new AbortController();
    referenceThumbnail(resolved, abort.signal).then(
      (url) => {
        if (!abort.signal.aborted) setImage({ key: resolved.key, url });
      },
      () => undefined,
    );
    return () => abort.abort();
  }, [resolved?.key]);
  if (!resolved) return <span className="color-match-thumbnail" aria-hidden="true" />;
  if (resolved.kind === 'style')
    return (
      <span className="color-match-thumbnail color-match-style" aria-hidden="true">
        <Icon name="star" size={18} />
      </span>
    );
  return (
    <span className="color-match-thumbnail">
      {image?.key === resolved.key && <img src={image.url} alt={`Reference frame of ${resolved.label}`} />}
    </span>
  );
}
