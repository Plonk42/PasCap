import { Icon } from './icons.js';
import type { useWorkspace, WorkspaceLayout } from './workspace.js';

export type SidePanel = 'media' | 'inspector';

const PANELS = {
  media: { title: 'Media', controls: 'media-pane', collapse: 'panel-left-close', expand: 'panel-left-open' },
  inspector: {
    title: 'Inspector',
    controls: 'inspector-pane',
    collapse: 'panel-right-close',
    expand: 'panel-right-open',
  },
} as const;

export function toggleSidePanel(
  { layout, viewport, update }: Pick<ReturnType<typeof useWorkspace>, 'layout' | 'viewport' | 'update'>,
  panel: SidePanel,
): void {
  const key = panel === 'media' ? 'mediaOpen' : 'inspectorOpen';
  const open = !layout[key];
  const changes: Partial<WorkspaceLayout> = {};
  changes[key] = open;
  // Narrow windows show one side drawer at a time.
  if (open && viewport.width < 980) changes[panel === 'media' ? 'inspectorOpen' : 'mediaOpen'] = false;
  const focused = globalThis.document.activeElement?.closest('.panel-collapse, .panel-rail') != null;
  update(changes);
  if (!focused) return;
  // The activated button unmounts or hides; keep focus on its counterpart.
  const target = open ? `#${panel}-pane .panel-collapse` : `.panel-rail-${panel}`;
  requestAnimationFrame(() => globalThis.document.querySelector<HTMLElement>(target)?.focus());
}
interface Props {
  panel: SidePanel;
  disabled: boolean;
  onToggle: (panel: SidePanel) => void;
}

/** Collapses a side panel to its rail, from the panel's own heading. */
export function PanelCollapseButton({ panel, disabled, onToggle }: Readonly<Props>) {
  const { title, controls, collapse } = PANELS[panel];
  return (
    <button
      type="button"
      className="icon-button panel-collapse"
      aria-label={`Collapse ${title} panel`}
      title={`Collapse ${title} to the side`}
      aria-expanded
      aria-controls={controls}
      disabled={disabled}
      onClick={() => onToggle(panel)}
    >
      <Icon name={collapse} size={16} />
    </button>
  );
}

/** The slim strip a collapsed side panel leaves; the whole strip expands it again. */
export function PanelRail({ panel, disabled, onToggle }: Readonly<Props>) {
  const { title, controls, expand } = PANELS[panel];
  return (
    <button
      type="button"
      className={`panel-rail panel-rail-${panel}`}
      aria-label={`Expand ${title} panel`}
      title={`Expand ${title}`}
      aria-expanded={false}
      aria-controls={controls}
      disabled={disabled}
      onClick={() => onToggle(panel)}
    >
      <Icon name={expand} size={16} />
      <span aria-hidden="true">{title}</span>
    </button>
  );
}
