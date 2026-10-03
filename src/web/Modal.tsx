import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import './activity.css';

export interface ModalProps {
  className: string;
  labelledBy: string;
  describedBy?: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  error?: string;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export function Modal({ className, labelledBy, describedBy, busy, onClose, children, footer, error = '', restoreFocusTo }: Readonly<ModalProps>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const errorId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const owner = element.ownerDocument;
    const active = owner.activeElement;
    // A trigger may have become disabled while an async action or lazy dialog
    // loaded. An explicit ref preserves that origin rather than guessing body.
    const trigger = restoreFocusTo?.current ?? (active instanceof HTMLElement && !element.contains(active) ? active : null);
    if (!element.open) element.showModal();
    return () => {
      const shouldRestore = element.contains(owner.activeElement) || owner.activeElement === owner.body;
      if (element.open) element.close();
      // Let the closing render re-enable the trigger. Do not steal focus from
      // another dialog, Activity, or an editor control that was explicitly focused.
      queueMicrotask(() => {
        if (!shouldRestore || !trigger?.isConnected || trigger.matches(':disabled') || trigger.closest('[inert]')) return;
        // Nested confirmations return to their still-open parent, not outside it.
        const activeDialog = Array.from(owner.querySelectorAll('dialog[open]')).at(-1);
        if (activeDialog && !activeDialog.contains(trigger)) return;
        const focused = owner.activeElement;
        if (focused instanceof HTMLElement && focused !== owner.body && focused !== trigger && !element.contains(focused)) return;
        trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  const description = [describedBy, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return <dialog ref={dialog} className={`app-dialog activity-modal ${className}`} aria-labelledby={labelledBy} aria-describedby={description} aria-busy={busy} onCancel={(event) => {
    event.preventDefault(); if (!busy) onClose();
  }}>
    <div className="activity-modal-body">{children}</div>
    {error && <p className="activity-dialog-error" id={errorId} role="alert">{error}</p>}
    {footer && <footer className="activity-modal-footer">{footer}</footer>}
  </dialog>;
}
