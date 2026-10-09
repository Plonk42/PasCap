import type { ReactNode } from 'react';
import { Icon } from './icons.js';
import './disclosure.css';

interface Props {
  title: string;
  label: string;
  triggerId: string;
  contentId: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  className: string;
  contentClassName?: string;
  beforeTitle?: ReactNode;
  afterTitle?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** Independent native header actions; hiding content never unmounts its drafts. */
export function Disclosure({
  title,
  label,
  triggerId,
  contentId,
  open,
  onToggle,
  className,
  contentClassName = '',
  beforeTitle,
  afterTitle,
  help,
  actions,
  children,
}: Readonly<Props>) {
  return (
    <section className={`heading-disclosure ${className}`} data-open={open}>
      <div className="disclosure-heading">
        <h3 className="disclosure-title" aria-label={title}>
          <button
            type="button"
            id={triggerId}
            className="disclosure-trigger"
            aria-label={label}
            aria-controls={contentId}
            aria-expanded={open}
            onClick={() => onToggle(!open)}
          >
            <Icon name="chevron-down" size={12} />
            {beforeTitle}
            <span className="disclosure-title-text">{title}</span>
            {afterTitle}
          </button>
        </h3>
        {help}
      </div>
      {actions}
      <div
        className={`disclosure-content ${contentClassName}`}
        id={contentId}
        aria-labelledby={triggerId}
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
