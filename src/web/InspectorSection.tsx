import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import './declutter.css';
import { Disclosure } from './Disclosure.js';
import { Icon, type IconName } from './icons.js';
import './input-controls.css';
import { readPreference, writePreference } from './preferences.js';

export type InspectorMode = 'clip' | 'track' | 'audio';

const SECTION_DEFAULTS = {
  source: false,
  // Placement retains this browser preference ID; renaming its title must not reset expansion.
  'layer-opacity': false,
  speed: false,
  transform: false,
  colour: true,
  keyframes: true,
  transition: true,
  fades: true,
  music: true,
};
type SectionId = keyof typeof SECTION_DEFAULTS;
const CLIP_SECTIONS: readonly SectionId[] = ['source', 'layer-opacity', 'speed', 'transform'];
type Expansion = Record<SectionId, boolean>;
interface InspectorExpansion {
  sections: Expansion;
  setOpen: (id: SectionId, open: boolean) => void;
}
export const InspectorExpansionContext = createContext<InspectorExpansion | null>(null);

/** Include temporarily absent Clip sections, so selecting a clip respects bulk choices. */
export function useInspectorExpansion() {
  const [sections, setSections] = useState<Expansion>(
    () =>
      Object.fromEntries(
        Object.entries(SECTION_DEFAULTS).map(([id, defaultOpen]) => {
          const saved = readPreference(`pascap-section-${id}`);
          return [id, saved === null ? defaultOpen : saved === 'open'];
        }),
      ) as Expansion,
  );
  const [storageWarning, setStorageWarning] = useState(false);
  const persist = (id: SectionId, open: boolean): void => {
    if (!writePreference(`pascap-section-${id}`, open ? 'open' : 'closed')) setStorageWarning(true);
  };
  const setOpen = (id: SectionId, open: boolean): void => {
    setSections((previous) => ({ ...previous, [id]: open }));
    persist(id, open);
  };
  const allOpen = CLIP_SECTIONS.every((id) => sections[id]);
  const toggleAll = (): void => {
    const open = !allOpen;
    setSections((previous) => ({ ...previous, ...Object.fromEntries(CLIP_SECTIONS.map((id) => [id, open])) }));
    CLIP_SECTIONS.forEach((id) => persist(id, open));
  };
  return { sections, setOpen, allOpen, toggleAll, storageWarning };
}

export function InspectorExpansionControls({
  expansion,
  hidden,
}: Readonly<{ expansion: ReturnType<typeof useInspectorExpansion>; hidden: boolean }>) {
  if (hidden) return null;
  const label = expansion.allOpen ? 'Collapse all Inspector settings' : 'Expand all Inspector settings';
  return (
    <>
      <button
        type="button"
        className="icon-button inspector-expansion"
        aria-label={label}
        title={`${expansion.allOpen ? 'Collapse' : 'Expand'} all Clip sections`}
        onClick={expansion.toggleAll}
      >
        <Icon name={expansion.allOpen ? 'collapse-all' : 'expand-all'} size={16} />
      </button>
      {expansion.storageWarning && (
        <output className="control-hint">
          Section preferences cannot be saved in this browser. Your choices remain available for this session.
        </output>
      )}
    </>
  );
}

/** Editor-only expansion state, not a renderable project setting. */
export function InspectorSection({
  id,
  title,
  children,
  icon,
  badge,
  modified = false,
  help,
}: Readonly<{
  id: SectionId;
  title: string;
  children: ReactNode;
  icon?: IconName;
  badge?: ReactNode;
  modified?: boolean;
  help?: ReactNode;
}>) {
  const headingId = useId();
  const contentId = `${headingId}-content`;
  const expansion = useContext(InspectorExpansionContext);
  if (!expansion) throw new Error('Inspector sections require their shared expansion state.');
  return (
    <Disclosure
      className="inspector-section"
      contentClassName="inspector-section-content"
      title={title}
      label={`${title} section`}
      triggerId={headingId}
      contentId={contentId}
      open={expansion.sections[id]}
      onToggle={(expanded) => expansion.setOpen(id, expanded)}
      beforeTitle={icon && <Icon name={icon} size={15} />}
      afterTitle={
        <>
          {badge && <span className="inspector-section-badge">{badge}</span>}
          {modified && (
            <span
              className="inspector-section-modified"
              title="Adjusted or animated"
              aria-label="Adjusted or animated"
            />
          )}
        </>
      }
      help={help}
    >
      {children}
    </Disclosure>
  );
}
