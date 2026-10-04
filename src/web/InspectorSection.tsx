import { useId, useState, type ReactNode } from 'react';
import './declutter.css';
import './input-controls.css';
import { Disclosure } from './Disclosure.js';
import { Icon, type IconName } from './icons.js';
import { readPreference, writePreference } from './preferences.js';

export type InspectorMode = 'clip' | 'sequence' | 'audio';

/** Editor-only expansion state, not a renderable project setting. */
export function InspectorSection({ id, title, children, defaultOpen = true, icon, badge, modified = false, help }: Readonly<{ id: string; title: string; children: ReactNode; defaultOpen?: boolean; icon?: IconName; badge?: ReactNode; modified?: boolean; help?: ReactNode }>) {
  const headingId = useId();
  const contentId = `${headingId}-content`;
  const [open, setOpen] = useState(() => {
    const saved = readPreference(`pascap-section-${id}`);
    return saved === null ? defaultOpen : saved === 'open';
  });
  return <Disclosure className="inspector-section" contentClassName="inspector-section-content" title={title} label={`${title} section`} triggerId={headingId} contentId={contentId} open={open} onToggle={(expanded) => {
    setOpen(expanded); writePreference(`pascap-section-${id}`, expanded ? 'open' : 'closed');
  }} beforeTitle={icon && <Icon name={icon} size={15} />} afterTitle={<>{badge && <span className="inspector-section-badge">{badge}</span>}{modified && <span className="inspector-section-modified" title="Adjusted or animated" aria-label="Adjusted or animated" />}</>} help={help}>{children}</Disclosure>;
}
