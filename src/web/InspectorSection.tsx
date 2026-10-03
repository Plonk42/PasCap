import { useId, useState, type ReactNode } from 'react';
import './declutter.css';
import './input-controls.css';
import { readPreference, writePreference } from './preferences.js';

export type InspectorMode = 'clip' | 'sequence' | 'audio';

/** Editor-only expansion state, not a renderable project setting. */
export function InspectorSection({ id, title, children, defaultOpen = true }: Readonly<{ id: string; title: string; children: ReactNode; defaultOpen?: boolean }>) {
  const headingId = useId();
  const contentId = `${headingId}-content`;
  const [open, setOpen] = useState(() => {
    const saved = readPreference(`pascap-section-${id}`);
    return saved === null ? defaultOpen : saved === 'open';
  });
  return <details className="inspector-section" open={open} onToggle={(event) => {
    const expanded = event.currentTarget.open;
    if (expanded === open) return;
    setOpen(expanded); writePreference(`pascap-section-${id}`, expanded ? 'open' : 'closed');
  }}><summary id={headingId} aria-label={`${title} section`} aria-controls={contentId} aria-expanded={open}><h3 className="inspector-section-title">{title}</h3></summary><div className="inspector-section-content" id={contentId} aria-labelledby={headingId}>{children}</div></details>;
}
