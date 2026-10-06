import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { GpuComparison, GpuCompositionComparison } from '../preview/compositor.js';
import type { PreviewDiagnostics, PreviewEngine } from '../preview/engine.js';
import type { AudioAsset } from '../shared/audio.js';
import type { ColourSettings } from '../shared/colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../shared/commands.js';
import type { ExportProfile } from '../shared/export.js';
import { needsLayeredExport } from '../shared/export.js';
import {
  resolveMediaSelection,
  validateMediaSelection,
  type MediaSelection,
  type MediaSelections,
} from '../shared/media-selection.js';
import type { MediaAsset, MediaJob } from '../shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../shared/model.js';
import { projectAudioIds, projectVideoIds, type ProjectSummary } from '../shared/projects.js';
import { removeMarkedRange, trimAtPlayhead, type ClipCutRange } from '../shared/rush-editing.js';
import { forEachSerial } from '../shared/serial.js';
import { validateSourceRanges } from '../shared/source-range.js';
import { calculateLayout, layerClips } from '../shared/timeline.js';
import { api, type RequestOptions } from './api.js';
import { Autosave, type SaveState } from './autosave.js';
import { waitForService } from './connection.js';
import { DeferredPanel } from './DeferredPanel.js';
import { mediaReady } from './display.js';
import { Icon } from './icons.js';
import type { InspectorMode } from './InspectorSection.js';
import { Jobs } from './Jobs.js';
import {
  inspectKeyframe,
  KeyframeNavigationContext,
  reconcileKeyframeInspection,
  type KeyframeInspection,
} from './keyframe-navigation.js';
import { clipStartRestriction } from './layer-actions.js';
import { MediaLibrary, type ImportResult, type ReviewTarget } from './MediaLibrary.js';
import { MusicControls } from './MusicControls.js';
import { Popover } from './Popover.js';
import { writePreference } from './preferences.js';
import { PreviewPanel } from './PreviewPanel.js';
import { ProjectTitle } from './ProjectTitle.js';
import { editorShortcut } from './shortcuts.js';
import { planTimelineDrop } from './timeline-placement.js';
import { Timeline, type DraftPreview } from './Timeline.js';
import { DEFAULT_LAYOUT, useWorkspace, WorkspaceResizer } from './workspace.js';

interface EditorDebug {
  engine: PreviewEngine;
  project: () => ProjectDocument | null;
  verifyColour: (settings: ColourSettings) => GpuComparison;
  verifyComposition: () => GpuCompositionComparison;
  setDocument: (document: ProjectDocument) => void;
  flush: () => Promise<void>;
}
declare global {
  interface Window {
    pascapLab?: EditorDebug;
  }
}

const Projects = lazy(() => import('./Projects.js').then((module) => ({ default: module.Projects })));
const ExportDialog = lazy(() => import('./ExportDialog.js').then((module) => ({ default: module.ExportDialog })));
const SaveRecovery = lazy(() => import('./SaveRecovery.js').then((module) => ({ default: module.SaveRecovery })));
const ShortcutHelp = lazy(() => import('./ShortcutHelp.js').then((module) => ({ default: module.ShortcutHelp })));
const SourceReview = lazy(() => import('./SourceReview.js').then((module) => ({ default: module.SourceReview })));
const loadInspector = () => import('./Inspector.js').then((module) => ({ default: module.Inspector }));
const loadDiagnostics = () => import('./Diagnostics.js').then((module) => ({ default: module.Diagnostics }));
const EMPTY_PROJECT = createProject('preview-lab', 'Untitled');
const SAVE_LABEL: Record<SaveState['state'], string> = {
  saved: 'Saved locally',
  saving: 'Saving…',
  error: 'Save error',
  unsaved: 'Unsaved',
};
function timingKey(project: ProjectDocument): string {
  return JSON.stringify({
    id: project.id,
    frameRate: project.frameRate,
    colourProfile: project.colourProfile,
    layers: project.layers
      .filter((layer) => project.clips.some((clip) => clip.layerId === layer.id))
      .map((layer) => ({
        id: layer.id,
        ripple: layer.ripple,
        transitions: layer.transitions,
        openingFade: layer.openingFade,
        closingFade: layer.closingFade,
        keys: layer.keyframes
          .filter((key) => key.values.speed !== null)
          .map((key) => ({ frame: key.frame, interpolation: key.interpolation, value: key.values.speed })),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    clips: project.clips.map(({ id, mediaId, layerId, start, sourceIn, sourceOut, speed }) => ({
      id,
      mediaId,
      layerId,
      start,
      sourceIn,
      sourceOut,
      speed,
    })),
    music: project.music,
  });
}

function shortcutBlocked(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    event.defaultPrevented ||
    !!document.querySelector('dialog[open]') ||
    (target instanceof HTMLElement &&
      target.closest(
        'input,textarea,select,[role="slider"],[role="separator"],[contenteditable="true"],.source-review,.activity-drawer,.editor-popover,.editor-help,.clip-speed-curve-editor',
      ) !== null)
  );
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
type ActionResult<T> = { ok: true; value: T } | { ok: false };
interface ConnectionState {
  state: 'connecting' | 'ready' | 'error';
  message: string;
}

function previewIsLoading(connection: ConnectionState, ready: boolean, error: string): boolean {
  return connection.state === 'connecting' || (!ready && !error);
}

function WorkspacePanels({
  workspace,
  disabled,
}: Readonly<{ workspace: ReturnType<typeof useWorkspace>; disabled: boolean }>) {
  return (
    <fieldset className="workspace-panel-controls">
      <legend className="declutter-sr-only">Editor panels</legend>
      <button
        className={`icon-button ${workspace.layout.mediaOpen ? 'active' : ''}`}
        aria-label="Toggle Media panel"
        aria-controls="media-pane"
        aria-pressed={workspace.layout.mediaOpen}
        title="Show or hide Media"
        disabled={disabled}
        onClick={() =>
          workspace.update({
            mediaOpen: !workspace.layout.mediaOpen,
            ...(workspace.viewport.width < 980 ? { inspectorOpen: false } : {}),
          })
        }
      >
        <Icon name="folder" size={17} />
      </button>
      <button
        className={`icon-button ${workspace.layout.inspectorOpen ? 'active' : ''}`}
        aria-label="Toggle Clip panel"
        aria-controls="inspector-pane"
        aria-pressed={workspace.layout.inspectorOpen}
        title="Show or hide Inspector"
        disabled={disabled}
        onClick={() =>
          workspace.update({
            inspectorOpen: !workspace.layout.inspectorOpen,
            ...(workspace.viewport.width < 980 ? { mediaOpen: false } : {}),
          })
        }
      >
        <Icon name="sliders" size={17} />
      </button>
    </fieldset>
  );
}

export function App() {
  const workspace = useWorkspace();
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  const [project, setProject] = useState<ProjectDocument | null>(null);
  const [draft, setDraft] = useState<DraftPreview | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [audioAssets, setAudioAssets] = useState<AudioAsset[]>([]);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({
    state: 'connecting',
    message: 'Connecting to the local service…',
  });
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [actionError, setActionError] = useState('');
  const [activityError, setActivityError] = useState('');
  const [importRequest, setImportRequest] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [musicImportOpen, setMusicImportOpen] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [revealRequest, setRevealRequest] = useState(0);
  const [cutRange, setCutRange] = useState<ClipCutRange | null>(null);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>('clip');
  const [draggedMediaIds, setDraggedMediaIds] = useState<string[] | null>(null);
  const [viewerMode, setViewerMode] = useState<'timeline' | 'source'>('timeline');
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [reviewPinned, setReviewPinned] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState(EMPTY_PROJECT.layers[0]!.id);
  const [keyframeInspection, setKeyframeInspection] = useState<KeyframeInspection | null>(null);
  const [ranges, setRanges] = useState<MediaSelections>({});
  const [boundaryId, setBoundaryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PreviewDiagnostics | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewStartupError, setPreviewStartupError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({
    state: 'saved',
    message: 'Local project',
    revision: 0,
    recovery: null,
  });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<PreviewEngine | null>(null);
  const autosave = useRef<Autosave | null>(null);
  const history = useRef<EditHistory | null>(null);
  const current = useRef<ProjectDocument | null>(null);
  const latestAssets = useRef<MediaAsset[]>([]);
  const latestAudio = useRef<AudioAsset[]>([]);
  const selection = useRef<string | null>(null);
  const selectedLayer = useRef(EMPTY_PROJECT.layers[0]!.id);
  const sourceRanges = useRef<MediaSelections>({});
  const drafting = useRef(false);
  const requestedFrame = useRef<number | null>(null);
  const restoreFrame = useRef(0);
  const lastPreview = useRef('');
  const mounted = useRef(false);
  const actionPending = useRef(false);
  const refreshSequence = useRef(0);
  const jobGeneration = useRef(0);
  const pinned = useRef(false);
  const exportAccepted = useRef(false);
  const timelineTab = useRef<HTMLButtonElement>(null);
  const projectsTrigger = useRef<HTMLButtonElement>(null);
  const exportTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      autosave.current?.dispose();
    };
  }, []);

  const select = useCallback((id: string) => {
    if (selection.current !== id) setCutRange(null);
    selection.current = id;
    setSelectedId(id);
    setViewerMode('timeline');
    const document = current.current;
    const layerId = document?.clips.find((clip) => clip.id === id)?.layerId;
    if (layerId) {
      if (selectedLayer.current !== layerId) setKeyframeInspection(null);
      selectedLayer.current = layerId;
      setSelectedLayerId(layerId);
    }
    const transitions = document?.layers.find((item) => item.id === layerId)?.transitions;
    const boundary =
      transitions?.find((item) => item.leftId === id) ?? transitions?.find((item) => item.rightId === id);
    setBoundaryId(boundary?.leftId ?? null);
  }, []);
  const refresh = useCallback(async (options?: RequestOptions) => {
    const sequence = ++refreshSequence.current;
    const generation = jobGeneration.current;
    const [library, queue, audio] = await Promise.all([api.library(options), api.jobs(options), api.audio(options)]);
    if (!mounted.current || options?.signal?.aborted || sequence !== refreshSequence.current) return;
    latestAssets.current = library.assets;
    setAssets(library.assets);
    latestAudio.current = audio.assets;
    setAudioAssets(audio.assets);
    // A GET begun before a newly accepted job must not erase that job's feedback.
    if (generation === jobGeneration.current) setJobs(queue.jobs);
  }, []);
  const receiveJob = useCallback((job: MediaJob): void => {
    jobGeneration.current++;
    setJobs((previous) => [...previous.filter((item) => item.id !== job.id), job]);
  }, []);
  const validate = useCallback((document: ProjectDocument): void => {
    projectSchema.parse(document);
    validateSourceRanges(document, new Map(latestAssets.current.map((asset) => [asset.id, asset.metadata.frameCount])));
    if (document.music) {
      const asset = latestAudio.current.find((item) => item.id === document.music!.mediaId);
      if (!asset || document.music.sourceOut > asset.metadata.frameCount)
        throw new Error('Music range exceeds the registered original.');
    }
  }, []);
  const publish = useCallback(
    (next: ProjectDocument) => {
      const previous = current.current;
      if (!previous || timingKey(previous) !== timingKey(next)) {
        engine.current?.pause();
        setCutRange(null);
      }
      current.current = next;
      setProject(next);
      autosave.current?.update(next);
      setHistoryState({ canUndo: history.current?.canUndo ?? false, canRedo: history.current?.canRedo ?? false });
      if (!next.layers.some((layer) => layer.id === selectedLayer.current)) {
        selectedLayer.current = next.layers[0]!.id;
        setSelectedLayerId(selectedLayer.current);
        setKeyframeInspection(null);
        setBoundaryId(null);
      }
      const selectedClip = next.clips.find((clip) => clip.id === selection.current);
      if (!selectedClip && selection.current !== null) {
        const first = calculateLayout(next).clips.find((item) => item.clip.layerId === selectedLayer.current);
        if (first) select(first.clip.id);
        else {
          selection.current = null;
          setSelectedId(null);
          setBoundaryId(null);
        }
      } else if (
        selectedClip &&
        previous?.clips.find((clip) => clip.id === selection.current)?.layerId !== selectedClip.layerId
      ) {
        selectedLayer.current = selectedClip.layerId;
        setSelectedLayerId(selectedClip.layerId);
        setKeyframeInspection(null);
      }
    },
    [select],
  );
  const commit = useCallback(
    (next: ProjectDocument) => {
      const previous = current.current;
      // Keep imported and previously used sources in the bin even after removing their last excerpt.
      const document = {
        ...next,
        media: {
          videoIds: [...new Set([...projectVideoIds(next), ...(previous ? projectVideoIds(previous) : [])])],
          audioIds: [...new Set([...projectAudioIds(next), ...(previous ? projectAudioIds(previous) : [])])],
        },
      };
      validate(document);
      if (!history.current) throw new Error('Project has not loaded yet.');
      publish(history.current.replace(document));
    },
    [publish, validate],
  );
  const edit = useCallback(
    (command: EditCommand): void => {
      if (!current.current) return;
      try {
        const next = applyCommand(current.current, command);
        validate(next);
        if (command.type === 'trim' || command.type === 'trim-place') {
          const placed = calculateLayout(next).clips.find((item) => item.clip.id === command.clipId)!;
          const previous = current.current.clips.find((item) => item.id === command.clipId)!;
          requestedFrame.current = previous.sourceIn !== command.sourceIn ? placed.start : placed.end - 1;
        }
        commit(next);
        setError('');
        setViewerMode('timeline');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Invalid edit');
      }
    },
    [commit, validate],
  );
  const undoRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      if (!history.current || drafting.current) return;
      try {
        publish(history.current[direction]());
        setCutRange(null);
        setError('');
        setViewerMode('timeline');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Cannot restore edit');
      }
    },
    [publish],
  );
  const insert = useCallback(
    (mediaIds: string[], index?: number, layerId?: string, start?: number, keepReview = false): string | null => {
      if (!current.current || drafting.current || !mediaIds.length) return null;
      try {
        let next = current.current;
        const targetLayer = layerId ?? selectedLayer.current;
        const layer = next.layers.find((layer) => layer.id === targetLayer);
        if (!layer) throw new Error('Choose a video layer before inserting.');
        const instances = mediaIds.map((id) => {
          const asset = latestAssets.current.find((item) => item.id === id);
          if (!asset || !mediaReady(asset)) throw new Error('Prepare the recording before adding it to the timeline.');
          const range = resolveMediaSelection(id, asset.metadata.frameCount, sourceRanges.current);
          return createClip(crypto.randomUUID(), id, range.sourceIn, range.sourceOut, targetLayer);
        });
        const lastClip = layerClips(next, targetLayer).at(-1);
        const last = calculateLayout(next).clips.find((item) => item.clip.id === lastClip?.id);
        let cursor = start ?? (layer.ripple && last ? last.end : (engine.current?.diagnostics().frame ?? 0));
        let position = index;
        // Normal Add appends on Ripple tracks and uses the playhead on positioned
        // tracks. Native drops already supply this same core planner's exact slot.
        // Full-overlap dissolves can have tied slot starts: keep explicit append
        // intent rather than letting nearest-slot tie-breaking reorder an Add.
        if (layer.ripple && last && start === undefined) position ??= next.clips.length;
        if (position === undefined) {
          const plan = planTimelineDrop(
            next,
            { kind: 'media', clips: instances },
            targetLayer,
            cursor,
            false,
            0,
            engine.current?.diagnostics().frame ?? 0,
          );
          if (plan.error) throw new Error(plan.error);
          position = plan.index;
          cursor = plan.start;
        }
        for (const [offset, clip] of instances.entries()) {
          next = applyCommand(next, { type: 'insert', clip: { ...clip, start: cursor }, index: position + offset });
          cursor = calculateLayout(next).clips.find((item) => item.clip.id === clip.id)!.end;
        }
        validate(next);
        const first = instances[0]!; // The nonempty mediaIds guard also guarantees a nonempty batch.
        requestedFrame.current = calculateLayout(next).clips.find((item) => item.clip.id === first.id)!.start;
        commit(next);
        select(first.id);
        if (keepReview) {
          pinned.current = true;
          setReviewPinned(true);
          setViewerMode('source');
        }
        setError('');
        return first.id;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Cannot insert recording');
        return null;
      }
    },
    [commit, select, validate],
  );
  const seek = useCallback((frame: number): void => {
    const document = current.current;
    if (!document || drafting.current) return;
    setKeyframeInspection(null);
    const duration = calculateLayout(document).duration;
    if (duration) {
      setViewerMode('timeline');
      void engine.current?.seek(Math.max(0, Math.min(duration - 1, frame)));
    }
  }, []);
  const togglePlayback = useCallback(() => {
    if (drafting.current) return;
    setKeyframeInspection(null);
    setViewerMode('timeline');
    if (engine.current?.diagnostics().playing) engine.current.pause();
    else void engine.current?.play();
  }, []);
  const revealClip = (id: string): void => {
    if (drafting.current || !current.current) return;
    const placed = calculateLayout(current.current).clips.find((item) => item.clip.id === id);
    if (!placed) return;
    select(id);
    setRevealRequest((value) => value + 1);
    seek(placed.start);
  };
  const split = useCallback(() => {
    if (!current.current || !selection.current || drafting.current) return;
    const placed = calculateLayout(current.current).clips.find((item) => item.clip.id === selection.current);
    if (!placed) return;
    const frame = engine.current?.diagnostics().frame ?? 0;
    if (frame <= placed.start || frame >= placed.end) {
      setError('Place the playhead inside the selected clip to split it.');
      return;
    }
    const newClipId = crypto.randomUUID();
    try {
      const next = applyCommand(current.current, {
        type: 'split',
        clipId: placed.clip.id,
        sourceFrame: placed.retiming.sourceAt(frame - placed.start),
        newClipId,
      });
      requestedFrame.current = calculateLayout(next).clips.find((item) => item.clip.id === newClipId)!.start;
      commit(next);
      select(newClipId);
      setError('');
    } catch (cause) {
      setError(message(cause, 'Cannot split this excerpt.'));
    }
  }, [commit, select]);
  const quickTrim = useCallback(
    (edge: 'in' | 'out'): void => {
      if (!current.current || !selection.current || drafting.current) return;
      try {
        edit(trimAtPlayhead(current.current, selection.current, engine.current?.diagnostics().frame ?? 0, edge));
      } catch (cause) {
        setError(message(cause, 'Place the playhead inside the selected excerpt to trim it.'));
      }
    },
    [edit],
  );
  const markCut = useCallback((edge: 'in' | 'out'): void => {
    if (!current.current || !selection.current || drafting.current) return;
    const placed = calculateLayout(current.current).clips.find((item) => item.clip.id === selection.current);
    const frame = engine.current?.diagnostics().frame ?? 0;
    if (!placed || frame < placed.start || frame >= placed.end) {
      setError('Place the playhead inside the selected excerpt to mark a cut.');
      return;
    }
    engine.current?.pause();
    setViewerMode('timeline');
    setError('');
    setCutRange((previous) => {
      const marks =
        previous?.clipId === placed.clip.id ? previous : { clipId: placed.clip.id, inFrame: null, outFrame: null };
      return { ...marks, [edge === 'in' ? 'inFrame' : 'outFrame']: edge === 'in' ? frame : frame + 1 };
    });
  }, []);
  const cutMarked = useCallback((): void => {
    if (!current.current || !cutRange || drafting.current) return;
    const before = current.current;
    const newClipId = crypto.randomUUID();
    try {
      const next = applyCommand(before, removeMarkedRange(before, cutRange, newClipId));
      const previousIndex = before.clips.findIndex((clip) => clip.id === cutRange.clipId);
      const retained =
        next.clips.find((clip) => clip.id === newClipId) ??
        next.clips.find((clip) => clip.id === cutRange.clipId) ??
        next.clips[previousIndex] ??
        next.clips.at(-1);
      requestedFrame.current = Math.min(cutRange.inFrame ?? 0, Math.max(0, calculateLayout(next).duration - 1));
      commit(next);
      if (retained) select(retained.id);
      setCutRange(null);
      setError('');
      setViewerMode('timeline');
    } catch (cause) {
      setError(message(cause, 'Set valid cut marks inside the selected excerpt.'));
    }
  }, [commit, cutRange, select]);
  const remove = useCallback(() => {
    if (selection.current && !drafting.current) edit({ type: 'delete', clipId: selection.current });
  }, [edit]);
  const duplicate = useCallback(() => {
    if (!selection.current || !current.current || drafting.current) return;
    const newClipId = crypto.randomUUID();
    try {
      const next = applyCommand(current.current, { type: 'duplicate', clipId: selection.current, newClipId });
      requestedFrame.current = calculateLayout(next).clips.find((clip) => clip.clip.id === newClipId)!.start;
      commit(next);
      select(newClipId);
      setError('');
    } catch (cause) {
      setError(message(cause, 'The duplicate cannot fit here. Make room or use another layer.'));
    }
  }, [commit, select]);
  const nudge = useCallback(
    (delta: number) => {
      if (!current.current || !selection.current || drafting.current) return;
      const index = current.current.clips.findIndex((clip) => clip.id === selection.current);
      const clip = current.current.clips[index];
      if (!clip) return;
      const restriction = clipStartRestriction(current.current, clip);
      if (restriction) {
        setError(restriction);
        return;
      }
      const placed = calculateLayout(current.current).clips.find((item) => item.clip.id === clip.id)!;
      edit({ type: 'place', clipId: clip.id, layerId: clip.layerId, start: placed.start + delta, index });
    },
    [edit],
  );
  const previewDraft = useCallback((next: DraftPreview | null, frame?: number): void => {
    if (next) setKeyframeInspection(null);
    if (next && !drafting.current) restoreFrame.current = engine.current?.diagnostics().frame ?? 0;
    if (!next) requestedFrame.current = frame ?? restoreFrame.current;
    drafting.current = next !== null;
    setDraft(next);
  }, []);

  const installProject = useCallback(
    (loaded: ProjectDocument) => {
      engine.current?.pause();
      autosave.current?.dispose();
      history.current = new EditHistory(loaded);
      autosave.current = new Autosave(loaded, api.save, setSaveState);
      current.current = loaded;
      lastPreview.current = '';
      requestedFrame.current = 0;
      setKeyframeInspection(null);
      setProject(loaded);
      setDraft(null);
      drafting.current = false;
      setImportRequest(0);
      setDraggedMediaIds(null);
      setCutRange(null);
      setRevealRequest(0);
      setHistoryState({ canUndo: false, canRedo: false });
      setBoundaryId(null);
      selection.current = null;
      setSelectedId(null);
      selectedLayer.current = loaded.layers[0]!.id;
      setSelectedLayerId(selectedLayer.current);
      let choices: MediaSelections = {};
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(`pascap-media-ranges-${loaded.id}`) ?? '{}');
        if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
          throw new Error('Invalid source range choices.');
        for (const [id, value] of Object.entries(stored)) {
          const asset = latestAssets.current.find((item) => item.id === id);
          if (!asset) continue;
          if (
            typeof value !== 'object' ||
            value === null ||
            !('mediaId' in value) ||
            !('sourceIn' in value) ||
            !('sourceOut' in value)
          )
            throw new Error('Invalid stored source range.');
          const candidate = value as MediaSelection;
          validateMediaSelection(candidate, asset.metadata.frameCount);
          if (candidate.mediaId !== id) throw new Error('Source range refers to a different recording.');
          choices = { ...choices, [id]: candidate };
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? `${cause.message} Source range choices were not loaded; originals remain intact.`
            : 'Cannot read source range choices.',
        );
      }
      sourceRanges.current = choices;
      setRanges(choices);
      pinned.current = false;
      setReview(null);
      setReviewPinned(false);
      setViewerMode('timeline');
      const first = calculateLayout(loaded).clips[0];
      if (first) select(first.clip.id);
      setSaveState({ state: 'saved', message: 'Saved on this device', revision: loaded.revision, recovery: null });
      try {
        localStorage.setItem('pascap-project', loaded.id);
      } catch {
        setError('The project is open; this browser cannot remember the last project. Its URL remains available.');
      }
      const url = new URL(location.href);
      url.searchParams.set('project', loaded.id);
      window.history.replaceState(null, '', url);
    },
    [select],
  );
  const clearProject = (): void => {
    engine.current?.pause();
    autosave.current?.dispose();
    autosave.current = null;
    history.current = null;
    current.current = null;
    lastPreview.current = '';
    requestedFrame.current = 0;
    setKeyframeInspection(null);
    setProject(null);
    setDraft(null);
    drafting.current = false;
    setImportRequest(0);
    setCutRange(null);
    setRevealRequest(0);
    setHistoryState({ canUndo: false, canRedo: false });
    setBoundaryId(null);
    selection.current = null;
    setSelectedId(null);
    selectedLayer.current = EMPTY_PROJECT.layers[0]!.id;
    setSelectedLayerId(selectedLayer.current);
    sourceRanges.current = {};
    setRanges({});
    setDraggedMediaIds(null);
    pinned.current = false;
    setReview(null);
    setReviewPinned(false);
    setViewerMode('timeline');
    setSaveState({ state: 'saved', message: 'Local workspace', revision: 0, recovery: null });
    const url = new URL(location.href);
    url.searchParams.delete('project');
    window.history.replaceState(null, '', url);
  };
  const flushBeforeSwitch = async (): Promise<void> => {
    if (drafting.current) throw new Error('Finish or cancel the current drag before changing projects.');
    await autosave.current?.flush();
    if (autosave.current?.dirty)
      throw new Error('Current changes could not be saved. Resolve the save error before switching projects.');
  };

  useEffect(() => {
    if (!canvas.current) return;
    let disposed = false;
    let preview: PreviewEngine | null = null;
    let unsubscribe: (() => void) | null = null;
    setPreviewReady(false);
    setPreviewStartupError('');
    setDiagnostics(null);
    void import('../preview/bootstrap.js')
      .then((module) => {
        if (disposed || !canvas.current) return;
        preview = new module.PreviewEngine(canvas.current);
        engine.current = preview;
        lastPreview.current = '';
        unsubscribe = preview.subscribe(setDiagnostics);
        window.pascapLab = {
          engine: preview,
          project: () => current.current,
          verifyColour: module.verifyGpuColour,
          verifyComposition: module.verifyLayerComposition,
          setDocument: commit,
          flush: async () => {
            await autosave.current?.flush();
          },
        };
        setPreviewReady(true);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setPreviewStartupError(message(cause, 'Preview could not be opened. Check the local service, then retry.'));
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      preview?.dispose();
      if (engine.current === preview) {
        engine.current = null;
        delete window.pascapLab;
      }
    };
  }, [commit, previewAttempt]);
  useEffect(() => {
    const controller = new AbortController();
    setConnection({ state: 'connecting', message: 'Connecting to the local service…' });
    const initialise = async (): Promise<void> => {
      await waitForService(controller.signal, (attempt, max) => {
        if (!controller.signal.aborted)
          setConnection({
            state: 'connecting',
            message: `Connecting to the local service · attempt ${attempt} of ${max}`,
          });
      });
      await refresh({ signal: controller.signal });
      const list = (await api.projects({ signal: controller.signal })).projects;
      if (controller.signal.aborted) return;
      setProjectList(list);
      let preferred = new URL(location.href).searchParams.get('project');
      if (!preferred) {
        try {
          preferred = localStorage.getItem('pascap-project');
        } catch {
          /* URL/project picker remain available. */
        }
      }
      const requested = list.find((item) => item.id === preferred);
      let chosen = requested?.compatible ? requested : undefined;
      if (!preferred) chosen = list.find((item) => item.compatible);
      if (chosen) {
        const loaded = (await api.load(chosen.id, { signal: controller.signal })).document;
        if (controller.signal.aborted) return;
        installProject(loaded);
      } else {
        if (requested)
          setError(requested.error ?? 'This project is unavailable. Its saved document has not been changed.');
        else if (preferred)
          setError('The requested project was not found. Choose another project or create one below.');
        // Opening an empty workspace never makes a hidden/retried project-creation POST.
        setShowProjects(true);
      }
      setConnection({ state: 'ready', message: 'Connected to the local service' });
    };
    void initialise().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setConnection({
          state: 'error',
          message: message(cause, 'The local service is unavailable. Start it, then retry connecting.'),
        });
    });
    return () => {
      controller.abort();
    };
  }, [refresh, installProject, connectionAttempt]);
  useEffect(() => {
    if (!engine.current) return;
    const document = draft?.document ?? project ?? EMPTY_PROJECT;
    const key = `${draft ? 'draft' : 'committed'}:${timingKey(document)}`;
    if (key !== lastPreview.current) {
      lastPreview.current = key;
      const frame = draft?.frame ?? requestedFrame.current ?? engine.current.diagnostics().frame;
      if (!draft) requestedFrame.current = null;
      void engine.current
        .loadProject(document, (id) => `/api/media/${id}/proxy`, frame)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Cannot load preview'));
    } else {
      try {
        engine.current.updateProjectAppearance(document);
      } catch (cause) {
        setError(message(cause, 'Cannot update the preview appearance. Retry preview without changing your project.'));
      }
      if (requestedFrame.current !== null) {
        const frame = requestedFrame.current;
        requestedFrame.current = null;
        void engine.current
          .seek(frame)
          .catch((cause: unknown) => setError(message(cause, 'Cannot seek to the edited keyframe.')));
      }
    }
  }, [project, draft, previewReady]);
  useEffect(() => {
    if (!project) return;
    const transitions = project.layers.find((layer) => layer.id === selectedLayerId)?.transitions;
    if (boundaryId !== null && transitions?.some((item) => item.leftId === boundaryId)) return;
    const boundary =
      transitions?.find((item) => item.leftId === selectedId) ??
      transitions?.find((item) => item.rightId === selectedId);
    setBoundaryId(boundary?.leftId ?? null);
  }, [project, selectedId, selectedLayerId, boundaryId]);
  const trackingJobs = jobs.some((job) => ['queued', 'running'].includes(job.state));
  useEffect(() => {
    if ((!trackingJobs && !showActivity) || connection.state !== 'ready') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      let delay = 1000;
      try {
        await refresh({ signal: controller.signal });
        if (!controller.signal.aborted) setActivityError('');
      } catch (cause) {
        delay = 5000;
        if (!controller.signal.aborted)
          setActivityError(
            `${message(cause, 'Activity is unavailable.')} Last known job state is kept; Refresh only reads status, it does not resubmit work.`,
          );
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, delay);
    };
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trackingJobs, showActivity, connection.state, refresh]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (autosave.current?.dirty || drafting.current || document.querySelector('[data-dirty="true"]'))
        event.preventDefault();
    };
    const keyboard = (event: KeyboardEvent): void => {
      if (drafting.current || shortcutBlocked(event)) return;
      const nativeSpace =
        event.target instanceof HTMLElement && !!event.target.closest('button,a,summary,[role="tab"]');
      const shortcut = editorShortcut(event, nativeSpace);
      if (!shortcut) return;
      event.preventDefault();
      switch (shortcut.type) {
        case 'help':
          setShowHelp(true);
          break;
        case 'undo':
          undoRedo('undo');
          break;
        case 'redo':
          undoRedo('redo');
          break;
        case 'play':
          togglePlayback();
          break;
        case 'split':
          split();
          break;
        case 'trim-in':
          quickTrim('in');
          break;
        case 'trim-out':
          quickTrim('out');
          break;
        case 'mark-in':
          markCut('in');
          break;
        case 'mark-out':
          markCut('out');
          break;
        case 'remove-range':
          cutMarked();
          break;
        case 'clear-range':
          setCutRange(null);
          break;
        case 'duplicate':
          duplicate();
          break;
        case 'nudge':
          nudge(shortcut.delta);
          break;
        case 'remove':
          remove();
          break;
        case 'fit':
          setFitRequest((value) => value + 1);
          break;
        case 'start':
          seek(0);
          break;
        case 'end':
          if (current.current) seek(calculateLayout(current.current).duration - 1);
          break;
        case 'step':
          seek((engine.current?.diagnostics().frame ?? 0) + shortcut.delta);
          break;
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', keyboard);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('keydown', keyboard);
    };
  }, [remove, seek, split, duplicate, nudge, togglePlayback, undoRedo, quickTrim, markCut, cutMarked]);

  const act = async <T,>(
    action: () => Promise<T>,
    target: 'action' | 'activity' = 'action',
  ): Promise<ActionResult<T>> => {
    if (actionPending.current) return { ok: false };
    actionPending.current = true;
    setBusy(true);
    const report = target === 'activity' ? setActivityError : setActionError;
    report('');
    try {
      return { ok: true, value: await action() };
    } catch (cause) {
      if (mounted.current) report(message(cause, 'The action could not be completed. Your current edit is kept.'));
      return { ok: false };
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refreshAfterAcceptance = (): void => {
    void refresh().catch((cause: unknown) => {
      if (mounted.current)
        setActivityError(
          `${message(cause, 'Cannot refresh status.')} The request was accepted; check Activity before submitting it again.`,
        );
    });
  };
  const visible = draft?.document ?? project ?? EMPTY_PROJECT;
  const layout = calculateLayout(visible);
  const inspection = draft
    ? null
    : reconcileKeyframeInspection(
        keyframeInspection,
        project,
        selectedLayerId,
        diagnostics?.frame ?? 0,
        layout.duration,
        diagnostics?.playing ?? false,
      );
  if (inspection !== keyframeInspection) setKeyframeInspection(inspection);
  const selectedClip = visible.clips.find((clip) => clip.id === selectedId);
  const referenceBusy = jobs.some((job) => job.kind === 'reference' && ['running', 'queued'].includes(job.state));
  const setSourceRange = (range: MediaSelection): void => {
    try {
      const asset = latestAssets.current.find((item) => item.id === range.mediaId);
      if (!asset || !current.current)
        throw new Error('Load a project and register this recording before selecting a source range.');
      validateMediaSelection(range, asset.metadata.frameCount);
      const next = { ...sourceRanges.current, [range.mediaId]: { ...range } };
      sourceRanges.current = next;
      setRanges(next);
      if (!writePreference(`pascap-media-ranges-${current.current.id}`, JSON.stringify(next)))
        setError(
          'This source range is available for this session, but browser storage could not remember it. Existing clips and originals are unchanged.',
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cannot save source range choices.');
    }
  };
  const selectLayer = useCallback(
    (id: string): void => {
      if (drafting.current) return;
      if (selectedLayer.current !== id) setKeyframeInspection(null);
      setViewerMode('timeline');
      selectedLayer.current = id;
      setSelectedLayerId(id);
      const first = current.current && calculateLayout(current.current).clips.find((item) => item.clip.layerId === id);
      if (first) select(first.clip.id);
      else {
        selection.current = null;
        setSelectedId(null);
        setBoundaryId(null);
        setCutRange(null);
      }
    },
    [select],
  );
  const seekKeyframe = useCallback(
    (layerId: string, frame: number): void => {
      const document = current.current;
      if (!document || drafting.current) return;
      const layer = document.layers.find((item) => item.id === layerId);
      if (!layer) return;
      const duration = calculateLayout(document).duration;
      const next = inspectKeyframe(document.id, layer, frame, engine.current?.diagnostics().frame ?? 0, duration);
      if (!next) return;
      engine.current?.pause();
      if (selectedLayer.current !== layerId) selectLayer(layerId);
      setViewerMode('timeline');
      const workspace = latestWorkspace.current;
      if (!workspace.layout.inspectorOpen)
        workspace.update(
          { inspectorOpen: true, ...(workspace.viewport.width < 980 ? { mediaOpen: false } : {}) },
          false,
        );
      setKeyframeInspection(next);
      const preview = engine.current;
      if (lastPreview.current !== `committed:${timingKey(document)}`) requestedFrame.current = next.expectedFrame;
      // A just-committed Speed move may extend timing before the preview reloads.
      // Its requestedFrame is already queued; do not seek outside the old loaded layout.
      if (duration && preview && next.expectedFrame < preview.diagnostics().duration) {
        void preview
          .seek(next.expectedFrame)
          .catch((cause: unknown) => setError(message(cause, 'Cannot preview this keyframe.')));
      }
    },
    [selectLayer],
  );
  const followPlayhead = useCallback((): void => setKeyframeInspection(null), []);
  const navigationDisabled = !project || draft !== null || !previewReady;
  const keyframeNavigation = useMemo(
    () => ({
      inspection,
      duration: layout.duration,
      disabled: navigationDisabled,
      onSeekKeyframe: seekKeyframe,
      onFollowPlayhead: followPlayhead,
    }),
    [inspection, layout.duration, navigationDisabled, seekKeyframe, followPlayhead],
  );
  const openProject = async (id: string): Promise<boolean> =>
    (
      await act(async () => {
        await flushBeforeSwitch();
        installProject((await api.load(id)).document);
        setError('');
      })
    ).ok;
  const createNewProject = async (title: string): Promise<boolean> =>
    (
      await act(async () => {
        await flushBeforeSwitch();
        const loaded = (await api.createProject(title)).document;
        installProject(loaded);
        setError('');
        // A read failure cannot turn an accepted create into an invitation to retry the POST.
        void api
          .projects()
          .then((result) => {
            if (mounted.current) setProjectList(result.projects);
          })
          .catch(() => {
            /* Reopen Projects to read the latest list. */
          });
      })
    ).ok;
  const deleteProject = async (entry: ProjectSummary): Promise<boolean> =>
    (
      await act(async () => {
        const isCurrent = current.current?.id === entry.id;
        if (isCurrent) await flushBeforeSwitch();
        const revision = isCurrent ? autosave.current!.revision : entry.revision;
        await api.deleteProject(entry.id, entry.compatible ? revision : null);
        // Once deletion is accepted, a later read/storage failure must never invite a repeat DELETE.
        setProjectList((previous) => previous.filter((item) => item.id !== entry.id));
        if (isCurrent) {
          clearProject();
          setError('');
        }
        try {
          localStorage.removeItem(`pascap-media-ranges-${entry.id}`);
          if (localStorage.getItem('pascap-project') === entry.id) localStorage.removeItem('pascap-project');
        } catch {
          setError('The project was deleted, but this browser could not clear its saved project preference.');
        }
      })
    ).ok;
  const exportProject = async (profile: ExportProfile): Promise<boolean> =>
    (
      await act(async () => {
        await flushBeforeSwitch();
        if (!current.current) throw new Error('Open and save a project before exporting.');
        receiveJob(
          (
            await api.export(
              { ...current.current, revision: autosave.current?.revision ?? current.current.revision },
              profile,
            )
          ).job,
        );
        exportAccepted.current = true;
        refreshAfterAcceptance();
      })
    ).ok;
  const closeExport = (): void => {
    setShowExport(false);
    if (exportAccepted.current) {
      exportAccepted.current = false;
      setShowActivity(true);
    }
  };
  const openProjects = (): void => {
    setActionError('');
    setShowProjects(true);
    void act(async () => {
      setProjectList((await api.projects()).projects);
    });
  };
  const prepare = async (ids: string[]): Promise<void> => {
    const result = await act(async () => {
      // Serial requests respect the one-heavy-job queue; no hidden preparation on hover.
      await forEachSerial(new Set(ids), async (id) => {
        receiveJob((await api.prepare(id)).job);
      });
    });
    if (result.ok) refreshAfterAcceptance();
  };
  const importOriginals = async (operation: () => ReturnType<typeof api.importFolder>): Promise<ImportResult> => {
    if (!current.current) {
      setActionError('Create or open a project before importing recordings.');
      return { ok: false, added: 0, existing: 0, queued: 0, ignored: 0, rejected: [], queueErrors: [] };
    }
    const result = await act(operation);
    if (!result.ok) return { ok: false, added: 0, existing: 0, queued: 0, ignored: 0, rejected: [], queueErrors: [] };
    const imported = result.value;
    for (const job of imported.jobs) receiveJob(job);
    const merged = new Map(latestAssets.current.map((asset) => [asset.id, asset]));
    imported.assets.forEach((asset) => merged.set(asset.id, asset));
    latestAssets.current = [...merged.values()];
    setAssets(latestAssets.current);
    if (current.current)
      commit({
        ...current.current,
        media: {
          ...current.current.media,
          videoIds: [...new Set([...current.current.media.videoIds, ...imported.assets.map((asset) => asset.id)])],
        },
      });
    refreshAfterAcceptance();
    return {
      ok: true,
      added: imported.added,
      existing: imported.existing,
      queued: imported.jobs.length,
      ignored: imported.ignored,
      rejected: imported.errors.map((issue) => `${issue.path.split('/').at(-1)}: ${issue.message}`),
      queueErrors: imported.queueErrors.map(
        (issue) => `${merged.get(issue.mediaId)?.name ?? issue.mediaId}: ${issue.message}`,
      ),
    };
  };
  const importFolder = (directory: string): Promise<ImportResult> => importOriginals(() => api.importFolder(directory));
  const registerPaths = (paths: readonly string[]): Promise<ImportResult> =>
    importOriginals(() => api.registerPaths(paths));
  const importMusic = async (operation: () => ReturnType<typeof api.importAudio>): Promise<boolean> => {
    const importingProjectId = current.current?.id;
    if (!importingProjectId) {
      setActionError('Create or open a project before importing music.');
      return false;
    }
    const result = await act(async () => {
      const accepted = await operation();
      if (!mounted.current) return false;
      const asset = accepted.asset;
      latestAudio.current = [...latestAudio.current.filter((item) => item.id !== asset.id), asset];
      setAudioAssets(latestAudio.current);
      receiveJob(accepted.job);
      refreshAfterAcceptance();
      const importingProject = current.current;
      if (importingProject?.id !== importingProjectId)
        throw new Error(
          'Music registration was accepted, but the importing project is no longer open. No other project was changed. Check Activity and reopen the importing project before adding this music; do not repeat registration.',
        );
      try {
        commit({
          ...importingProject,
          media: { ...importingProject.media, audioIds: [...new Set([...importingProject.media.audioIds, asset.id])] },
        });
      } catch (cause) {
        throw new Error(
          `Music registration was accepted, but its project-bin update failed: ${message(cause, 'Cannot update the music bin.')} Check Activity and the project’s music bin before repeating the import.`,
        );
      }
      return true;
    });
    return result.ok && result.value;
  };
  const importAudio = (path: string): Promise<boolean> => importMusic(() => api.importAudio(path));
  const importSelectedAudio = (path: string): Promise<boolean> => importMusic(() => api.importSelectedAudio(path));
  const importVisibility = useCallback((open: boolean): void => {
    setImportOpen(open);
    if (open) setActionError('');
  }, []);
  const musicImportVisibility = useCallback((open: boolean): void => {
    setMusicImportOpen(open);
    if (open) setActionError('');
  }, []);
  const openMedia = (): void => {
    workspace.update({ mediaOpen: true, ...(workspace.viewport.width < 980 ? { inspectorOpen: false } : {}) });
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('[aria-label="Search media"]')?.focus({ preventScroll: true }),
    );
  };
  const requestImport = (): void => {
    if (!current.current) {
      openProjects();
      return;
    }
    openMedia();
    setActionError('');
    setImportRequest((value) => value + 1);
  };
  const retryPreview = (): void => {
    if (!engine.current) {
      setPreviewAttempt((attempt) => attempt + 1);
      return;
    }
    const document = current.current;
    if (!document) return;
    setViewerMode('timeline');
    void engine.current
      .loadProject(document, (id) => `/api/media/${id}/proxy`, engine.current.diagnostics().frame)
      .catch((cause: unknown) => setError(message(cause, 'Preview could not be retried.')));
  };
  const reviewSource = (next: ReviewTarget, pin: boolean): void => {
    if (!pin && pinned.current) return;
    setReview(next);
    setViewerMode('source');
    if (pin) {
      pinned.current = true;
      setReviewPinned(true);
    }
  };
  const closeReview = (): void => {
    pinned.current = false;
    setReviewPinned(false);
    setReview(null);
    setViewerMode('timeline');
    timelineTab.current?.focus({ preventScroll: true });
  };
  const refreshActivity = async (): Promise<boolean> => (await act(() => refresh(), 'activity')).ok;
  const downloadDraft = (): void => {
    if (!current.current) return;
    const snapshot = projectSchema.parse({
      ...current.current,
      revision: autosave.current?.revision ?? current.current.revision,
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${snapshot.id}-unsaved.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const reloadSaved = async (): Promise<boolean> =>
    (
      await act(async () => {
        if (!current.current) throw new Error('No project is open.');
        const loaded = (await api.load(current.current.id)).document;
        installProject(loaded);
        setError('');
      })
    ).ok;
  const reloadEditor = (): void => {
    void act(flushBeforeSwitch).then((result) => {
      if (result.ok) location.reload();
    });
  };
  const recoveryBusy = busy || draft !== null;
  const reviewAsset = assets.find((asset) => asset.id === review?.mediaId && mediaReady(asset));
  const reviewExcerpts = visible.clips
    .filter((clip) => clip.mediaId === reviewAsset?.id)
    .map((clip, index) => ({
      id: clip.id,
      index: index + 1,
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
      layerName: visible.layers.find((layer) => layer.id === clip.layerId)!.name,
    }));
  const navigateViewerTabs = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !reviewAsset) return;
    event.preventDefault();
    event.stopPropagation();
    const mode = event.key === 'Home' || (event.key !== 'End' && viewerMode === 'source') ? 'timeline' : 'source';
    setViewerMode(mode);
    document.getElementById(`${mode}-view-tab`)?.focus({ preventScroll: true });
  };
  const targetLayer = visible.layers.find((layer) => layer.id === selectedLayerId)?.name ?? visible.layers[0]!.name;
  const videoIds = project ? projectVideoIds(project) : new Set<string>();
  const audioIds = project ? projectAudioIds(project) : new Set<string>();
  const projectAssets = assets.filter((asset) => videoIds.has(asset.id));
  const projectAudio = audioAssets.filter((asset) => audioIds.has(asset.id));
  const dockStyle = {
    '--media-width': `${workspace.layout.mediaOpen ? workspace.sizes.media : 0}px`,
    '--inspector-width': `${workspace.layout.inspectorOpen ? workspace.sizes.inspector : 0}px`,
    '--timeline-height': `${workspace.sizes.timeline}px`,
    '--media-divider': workspace.layout.mediaOpen ? '8px' : '0px',
    '--inspector-divider': workspace.layout.inspectorOpen ? '8px' : '0px',
  } as CSSProperties;
  const modalErrorVisible = showProjects || showExport || showRecovery || importOpen || musicImportOpen;

  return (
    <KeyframeNavigationContext.Provider value={keyframeNavigation}>
      <div className="app-shell product-workspace">
        <nav className="skip-navigation" aria-label="Skip to editor panel">
          <a
            href="#media-pane"
            onClick={() =>
              workspace.update({ mediaOpen: true, ...(workspace.viewport.width < 980 ? { inspectorOpen: false } : {}) })
            }
          >
            Media
          </a>
          <a href="#viewer-pane">Preview</a>
          <a
            href="#inspector-pane"
            onClick={() =>
              workspace.update({ inspectorOpen: true, ...(workspace.viewport.width < 980 ? { mediaOpen: false } : {}) })
            }
          >
            Clip inspector
          </a>
          <a href="#timeline-pane">Timeline</a>
        </nav>
        <header className="app-header">
          <span className="brand" aria-label="PasCap">
            <span className="brand-mark">
              <Icon name="mountain" size={22} />
            </span>
            PasCap
          </span>
          <button
            ref={projectsTrigger}
            className="secondary-button small"
            aria-label="Open projects"
            disabled={busy || draft !== null || connection.state !== 'ready'}
            onClick={openProjects}
          >
            Projects
          </button>
          <ProjectTitle
            title={project?.title ?? 'No project open'}
            projectId={project?.id ?? null}
            disabled={!project || busy || draft !== null}
            onCommit={(title) => {
              if (current.current) {
                try {
                  commit({ ...current.current, title });
                } catch (cause) {
                  setError(message(cause, 'Cannot rename this project.'));
                }
              }
            }}
          />
          <div className="history-buttons">
            <button
              className="icon-button"
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={!historyState.canUndo || draft !== null}
              onClick={() => undoRedo('undo')}
            >
              <Icon name="undo" size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!historyState.canRedo || draft !== null}
              onClick={() => undoRedo('redo')}
            >
              <Icon name="redo" size={17} />
            </button>
          </div>
          <output
            className={`save-status ${saveState.state}`}
            title={saveState.message}
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="status-dot" />
            {project ? SAVE_LABEL[saveState.state] : 'Local workspace'}
          </output>
          <WorkspacePanels workspace={workspace} disabled={draft !== null} />
          <button
            className="icon-button workspace-help"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setShowHelp(true)}
          >
            <Icon name="help" size={18} />
          </button>
          <Popover label="Workspace options" className="workspace-options">
            <button
              className="secondary-button small"
              aria-label="Reset workspace layout"
              disabled={draft !== null}
              onClick={workspace.reset}
            >
              <Icon name="layout" size={16} />
              Reset layout
            </button>
            <button
              className="secondary-button small"
              aria-label="Toggle diagnostics"
              aria-pressed={showDiagnostics}
              onClick={() => setShowDiagnostics(!showDiagnostics)}
            >
              <Icon name="activity" size={16} />
              Diagnostics
            </button>
          </Popover>
          <button
            ref={exportTrigger}
            className="primary-button small"
            aria-label="Export video"
            disabled={!project?.clips.length || busy || draft !== null}
            onClick={() => {
              setActionError('');
              setShowExport(true);
            }}
          >
            <Icon name="download" size={15} />
            Export
          </button>
        </header>
        {connection.state !== 'ready' && (
          <output
            className={`connection-banner ${connection.state}`}
            role={connection.state === 'error' ? 'alert' : undefined}
          >
            <span>
              {connection.state === 'connecting' && <span className="spinner" />}
              {connection.message}
            </span>
            {connection.state === 'error' && (
              <button className="secondary-button" onClick={() => setConnectionAttempt((value) => value + 1)}>
                Retry connecting
              </button>
            )}
          </output>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {actionError && !modalErrorVisible && (
          <div className="error-banner" role="alert">
            <span>{actionError}</span>
            <button className="icon-button" aria-label="Dismiss action error" onClick={() => setActionError('')}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {saveState.state === 'error' && (
          <div className="save-recovery-banner" role="alert">
            <div>
              <strong>Unsaved changes are still in this editor</strong>
              <span>{saveState.message}</span>
            </div>
            {saveState.recovery === 'retry' && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  void act(async () => {
                    await autosave.current?.retry();
                  });
                }}
              >
                Retry save
              </button>
            )}
            <button className="secondary-button" onClick={downloadDraft}>
              Download unsaved project
            </button>
            <button
              className="text-button"
              disabled={busy || draft !== null}
              onClick={() => {
                setActionError('');
                setShowRecovery(true);
              }}
            >
              Review latest save
            </button>
          </div>
        )}
        <main
          className="workbench docked-workbench"
          style={dockStyle}
          data-media-open={workspace.layout.mediaOpen}
          data-inspector-open={workspace.layout.inspectorOpen}
        >
          <div className="workspace-media" id="media-pane" hidden={!workspace.layout.mediaOpen} tabIndex={-1}>
            <MediaLibrary
              key={project?.id ?? 'empty'}
              assets={projectAssets}
              project={project}
              ranges={ranges}
              busy={busy || !project || connection.state !== 'ready' || draft !== null}
              onInsert={insert}
              onDragMedia={setDraggedMediaIds}
              onPrepare={prepare}
              onImport={importFolder}
              onRegisterPaths={registerPaths}
              review={review}
              reviewPinned={reviewPinned}
              onReview={reviewSource}
              importRequest={importRequest}
              onImportVisibility={importVisibility}
              targetLayer={targetLayer}
              error={actionError}
            />
          </div>
          {workspace.layout.mediaOpen && (
            <WorkspaceResizer
              className="media-resizer"
              label="Resize Media panel"
              disabled={draft !== null}
              orientation="vertical"
              value={workspace.sizes.media}
              min={240}
              max={Math.floor(Math.max(240, Math.min(440, workspace.viewport.width * 0.29)))}
              defaultValue={DEFAULT_LAYOUT.mediaWidth}
              onChange={(mediaWidth, persist) => workspace.update({ mediaWidth }, persist)}
            />
          )}
          <div className="preview-column" id="viewer-pane" tabIndex={-1}>
            <div className="viewer-tabs" role="tablist" aria-label="Preview mode">
              <button
                ref={timelineTab}
                id="timeline-view-tab"
                role="tab"
                tabIndex={viewerMode === 'timeline' ? 0 : -1}
                aria-selected={viewerMode === 'timeline'}
                aria-controls="timeline-view"
                onKeyDown={navigateViewerTabs}
                onClick={() => setViewerMode('timeline')}
              >
                Timeline preview
              </button>
              <button
                id="source-view-tab"
                role="tab"
                tabIndex={viewerMode === 'source' ? 0 : -1}
                aria-selected={viewerMode === 'source'}
                aria-controls="source-view"
                disabled={!reviewAsset}
                onKeyDown={navigateViewerTabs}
                onClick={() => setViewerMode('source')}
              >
                Source preview{reviewPinned && <Icon name="pin" size={12} />}
              </button>
              <span>
                {reviewAsset && viewerMode === 'source'
                  ? 'Original source frames · muted'
                  : '720p proxies · originals on export'}
              </span>
            </div>
            <div
              id="timeline-view"
              className="viewer-panel"
              role="tabpanel"
              aria-labelledby="timeline-view-tab"
              hidden={viewerMode !== 'timeline'}
            >
              <PreviewPanel
                canvas={canvas}
                diagnostics={diagnostics}
                duration={layout.duration}
                drafting={draft !== null}
                onTogglePlayback={togglePlayback}
                onSeek={seek}
                onRetry={retryPreview}
                onMedia={openMedia}
                onImport={requestImport}
                loading={previewIsLoading(connection, previewReady, previewStartupError)}
                startupError={previewStartupError}
                onReload={reloadEditor}
                onDownload={downloadDraft}
                canDownload={project !== null}
                recoveryBusy={recoveryBusy}
              />
            </div>
            <div
              id="source-view"
              className="viewer-panel source-dock"
              role="tabpanel"
              aria-labelledby="source-view-tab"
              hidden={viewerMode !== 'source'}
            >
              <Suspense
                fallback={
                  <output className="source-loading">
                    <span className="spinner" />
                    Opening source preview…
                  </output>
                }
              >
                {reviewAsset && review && (
                  <SourceReview
                    asset={reviewAsset}
                    frame={review.frame}
                    range={resolveMediaSelection(reviewAsset.id, reviewAsset.metadata.frameCount, ranges)}
                    excerpts={reviewExcerpts}
                    disabled={!project || busy || draft !== null}
                    pinned={reviewPinned}
                    onPin={() => {
                      pinned.current = !pinned.current;
                      setReviewPinned(pinned.current);
                    }}
                    onFrame={(frame) => setReview({ mediaId: reviewAsset.id, frame })}
                    onRange={setSourceRange}
                    onClose={closeReview}
                    onInsert={() => insert([reviewAsset.id], undefined, undefined, undefined, true)}
                    onRevealClip={revealClip}
                    targetLayer={targetLayer}
                  />
                )}
              </Suspense>
            </div>
            {showDiagnostics && (
              <DeferredPanel
                label="Diagnostics"
                load={loadDiagnostics}
                onReload={reloadEditor}
                onDownload={downloadDraft}
                canDownload={project !== null}
                busy={recoveryBusy}
                fallback={<output className="source-loading">Opening diagnostics…</output>}
              >
                {(Diagnostics) => (
                  <Diagnostics
                    diagnostics={diagnostics}
                    colour={selectedClip?.colour ?? null}
                    canRenderReference={
                      !needsLayeredExport(visible) &&
                      visible.clips.length === 2 &&
                      visible.music === null &&
                      visible.clips.every((clip) => clip.speed.mode === 'constant' && clip.speed.rate === 1) &&
                      layout.duration <= 3600 &&
                      draft === null
                    }
                    referenceBusy={referenceBusy || busy}
                    onError={setError}
                    onReference={() => {
                      void act(async () => {
                        if (current.current)
                          receiveJob(
                            (
                              await api.reference({
                                ...current.current,
                                revision: autosave.current?.revision ?? current.current.revision,
                              })
                            ).job,
                          );
                      }).then((result) => {
                        if (result.ok) {
                          setShowActivity(true);
                          refreshAfterAcceptance();
                        }
                      });
                    }}
                  />
                )}
              </DeferredPanel>
            )}
          </div>
          {workspace.layout.inspectorOpen && (
            <WorkspaceResizer
              className="inspector-resizer"
              label="Resize Clip panel"
              disabled={draft !== null}
              orientation="vertical"
              direction={-1}
              value={workspace.sizes.inspector}
              min={270}
              max={Math.floor(Math.max(270, Math.min(440, workspace.viewport.width * 0.3)))}
              defaultValue={DEFAULT_LAYOUT.inspectorWidth}
              onChange={(inspectorWidth, persist) => workspace.update({ inspectorWidth }, persist)}
            />
          )}
          <div
            className="workspace-inspector"
            id="inspector-pane"
            hidden={!workspace.layout.inspectorOpen}
            tabIndex={-1}
          >
            <DeferredPanel
              label="Inspector"
              load={loadInspector}
              onReload={reloadEditor}
              onDownload={downloadDraft}
              canDownload={project !== null}
              busy={recoveryBusy}
              fallback={
                <output className="panel inspector-loading">
                  <span className="spinner" />
                  Opening Inspector…
                </output>
              }
            >
              {(Inspector) => (
                <Inspector
                  project={visible}
                  assets={assets}
                  selectedClipId={selectedId}
                  selectedLayerId={selectedLayerId}
                  boundaryId={boundaryId}
                  frame={diagnostics?.frame ?? 0}
                  drafting={draft !== null || !project}
                  section={inspectorMode}
                  onSection={setInspectorMode}
                  onEdit={edit}
                  onPreview={previewDraft}
                  onSeek={seek}
                  onPause={() => engine.current?.pause()}
                >
                  <MusicControls
                    key={project?.id ?? 'empty'}
                    project={visible}
                    assets={projectAudio}
                    busy={busy || !project || connection.state !== 'ready'}
                    drafting={draft !== null || !project}
                    error={actionError}
                    onBrowseVisibility={musicImportVisibility}
                    onEdit={edit}
                    onImport={importAudio}
                    onBrowseImport={importSelectedAudio}
                    onPrepare={async (id) => {
                      const result = await act(() => api.prepareAudio(id));
                      if (result.ok) {
                        receiveJob(result.value.job);
                        refreshAfterAcceptance();
                      }
                    }}
                  />
                </Inspector>
              )}
            </DeferredPanel>
          </div>
          <WorkspaceResizer
            className="timeline-resizer"
            label="Resize Timeline panel"
            disabled={draft !== null}
            orientation="horizontal"
            direction={-1}
            value={workspace.sizes.timeline}
            min={200}
            max={Math.max(200, Math.min(520, workspace.viewport.height - 360))}
            defaultValue={DEFAULT_LAYOUT.timelineHeight}
            onChange={(timelineHeight, persist) => workspace.update({ timelineHeight }, persist)}
          />
          <Timeline
            key={project?.id ?? 'empty'}
            project={project ?? EMPTY_PROJECT}
            assets={assets}
            audioAssets={audioAssets}
            selectedClipId={selectedId}
            selectedLayerId={selectedLayerId}
            onSelectLayer={selectLayer}
            selectedBoundaryId={boundaryId}
            frame={diagnostics?.frame ?? 0}
            onSelect={select}
            onBoundary={(id) => {
              select(id);
              setBoundaryId(id);
              setInspectorMode('sequence');
              workspace.update({
                inspectorOpen: true,
                ...(workspace.viewport.width < 980 ? { mediaOpen: false } : {}),
              });
            }}
            onSeek={seek}
            onPause={() => engine.current?.pause()}
            onEdit={edit}
            onInsert={insert}
            onPreview={previewDraft}
            onError={setError}
            onSplit={split}
            onDelete={remove}
            onDuplicate={duplicate}
            onNudge={nudge}
            onQuickTrim={quickTrim}
            cutRange={cutRange}
            onMarkCut={markCut}
            onCutMarked={cutMarked}
            onClearCut={() => setCutRange(null)}
            revealRequest={revealRequest}
            fitRequest={fitRequest}
            draggedMediaIds={draggedMediaIds}
            ranges={ranges}
          />
        </main>
        {workspace.storageError && <output className="workspace-preference-error">{workspace.storageError}</output>}
        <Jobs
          jobs={jobs}
          open={showActivity}
          onOpen={() => {
            setShowActivity(true);
            void refreshActivity();
          }}
          onClose={() => setShowActivity(false)}
          busy={busy}
          error={activityError}
          onRefresh={refreshActivity}
          onCancel={async (id) => {
            const result = await act(() => api.cancel(id), 'activity');
            if (result.ok) receiveJob(result.value.job);
            return result.ok;
          }}
        />
        <Suspense fallback={<output className="workspace-dialog-loading">Opening controls…</output>}>
          {showProjects && (
            <Projects
              projects={projectList}
              currentId={project?.id ?? null}
              busy={busy}
              error={actionError}
              restoreFocusTo={projectsTrigger}
              onOpen={openProject}
              onCreate={createNewProject}
              onDelete={deleteProject}
              onClose={() => setShowProjects(false)}
            />
          )}
          {showExport && project && (
            <ExportDialog
              project={project}
              jobs={jobs}
              busy={busy}
              error={actionError}
              restoreFocusTo={exportTrigger}
              onExport={exportProject}
              onClose={closeExport}
            />
          )}
          {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
          {showRecovery && (
            <SaveRecovery
              title={project?.title ?? 'Untitled'}
              state={saveState}
              busy={busy}
              error={actionError}
              onDownload={downloadDraft}
              onReload={reloadSaved}
              onClose={() => setShowRecovery(false)}
            />
          )}
        </Suspense>
      </div>
    </KeyframeNavigationContext.Provider>
  );
}
