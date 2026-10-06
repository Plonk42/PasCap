import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons.js';
import { popoverPosition, type PopoverPosition } from './popover-position.js';
import './help-popover.css';

interface Props {
  label: string;
  className?: string;
  children: ReactNode;
}
type HelpMode = 'closed' | 'preview' | 'pinned';
interface HelpRequest {
  id: string;
  pinned: boolean;
}
const OPEN_HELP = 'pascap-open-help';

/** Hover/focus previews never take focus; explicit activation keeps the help open. */
export function HelpPopover({ label, className = '', children }: Readonly<Props>) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<HelpMode>('closed');
  const currentMode = useRef<HelpMode>('closed');
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const hovering = useRef(false);
  const suppressed = useRef(false);
  const restoringFocus = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLeave = useCallback((): void => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const close = useCallback(
    (restoreFocus = false): void => {
      cancelLeave();
      const restore = restoreFocus && root.current?.contains(document.activeElement);
      suppressed.current = true;
      currentMode.current = 'closed';
      if (content.current?.matches(':popover-open')) content.current.hidePopover();
      setMode('closed');
      setPosition(null);
      const button = trigger.current;
      if (
        restore &&
        button?.isConnected &&
        button.getClientRects().length &&
        !button.matches(':disabled') &&
        !button.closest('[inert]')
      ) {
        restoringFocus.current = true;
        button.focus({ preventScroll: true });
        restoringFocus.current = false;
      }
    },
    [cancelLeave],
  );
  const show = useCallback(
    (next: 'preview' | 'pinned'): void => {
      cancelLeave();
      if (next === 'preview' && (suppressed.current || currentMode.current !== 'closed')) return;
      const request = new CustomEvent<HelpRequest>(OPEN_HELP, {
        cancelable: true,
        detail: { id, pinned: next === 'pinned' },
      });
      if (!document.dispatchEvent(request)) return;
      currentMode.current = next;
      setMode(next);
    },
    [cancelLeave, id],
  );
  const scheduleLeave = useCallback((): void => {
    cancelLeave();
    if (currentMode.current !== 'preview') return;
    // Allow travel across the small anchor/panel gap without flicker.
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      if (!hovering.current && !root.current?.contains(document.activeElement)) close();
    }, 150);
  }, [cancelLeave, close]);
  const place = useCallback((): void => {
    if (!trigger.current || !content.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    if (!anchor.width || !anchor.height) {
      close();
      return;
    }
    const panel = content.current.getBoundingClientRect();
    // Measure the full text even when the previous placement made it scrollable.
    const height = panel.height + Math.max(0, content.current.scrollHeight - content.current.clientHeight);
    const next = popoverPosition(anchor, { width: panel.width, height }, { width: innerWidth, height: innerHeight });
    setPosition((previous) =>
      previous?.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight
        ? previous
        : next,
    );
  }, [close]);

  useEffect(() => {
    const otherHelp = (event: Event): void => {
      const request = (event as CustomEvent<HelpRequest>).detail;
      if (request.id === id || currentMode.current === 'closed') return;
      // Another hover must not dismiss help that was explicitly pinned.
      if (currentMode.current === 'pinned' && !request.pinned) event.preventDefault();
      else close();
    };
    document.addEventListener(OPEN_HELP, otherHelp);
    return () => {
      document.removeEventListener(OPEN_HELP, otherHelp);
      cancelLeave();
    };
  }, [id, close, cancelLeave]);
  useLayoutEffect(() => {
    if (mode === 'closed') return;
    if (!content.current?.matches(':popover-open')) content.current?.showPopover();
    place();
  }, [mode, children, place]);
  useEffect(() => {
    if (mode === 'closed') return;
    const outsideClick = (event: MouseEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Dismiss help first, not an underlying input draft, modal or timeline gesture.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const resize = new ResizeObserver(place);
    if (content.current) resize.observe(content.current);
    if (trigger.current) resize.observe(trigger.current);
    const visibility = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) close();
    });
    if (trigger.current) visibility.observe(trigger.current);
    // Dismiss before an outside control captures a drag; its Escape remains owned.
    document.addEventListener('pointerdown', outsideClick, true);
    document.addEventListener('click', outsideClick, true);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener('pointerdown', outsideClick, true);
      document.removeEventListener('click', outsideClick, true);
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [mode, close, place]);

  return (
    <div
      ref={root}
      className={`editor-help ${className}`}
      data-help-mode={mode}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || event.buttons !== 0) return;
        hovering.current = true;
        suppressed.current = false;
        show('preview');
      }}
      onPointerLeave={() => {
        hovering.current = false;
        scheduleLeave();
      }}
      onFocusCapture={() => {
        if (restoringFocus.current) return;
        suppressed.current = false;
        show('preview');
      }}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          scheduleLeave();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="editor-help-trigger icon-button"
        aria-label={`${label} help`}
        aria-expanded={mode !== 'closed'}
        aria-pressed={mode === 'pinned'}
        aria-controls={id}
        aria-describedby={`${id}-instruction`}
        onPointerDown={(event) => {
          // A draft's blur can remove its hint and move this button before mouseup.
          // Focus on the completed click instead, retaining one ordinary blur commit.
          if (event.button === 0) event.preventDefault();
        }}
        onClick={(event) => {
          const wasPinned = currentMode.current === 'pinned';
          event.currentTarget.focus({ preventScroll: true });
          if (wasPinned) close();
          else {
            suppressed.current = false;
            show('pinned');
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && currentMode.current !== 'closed') {
            event.preventDefault();
            event.stopPropagation();
            content.current?.focus({ preventScroll: true });
          }
        }}
      >
        <Icon name="help" size={15} />
      </button>
      <span className="declutter-sr-only" id={`${id}-instruction`}>
        Hover or focus to read help. Click to keep it open, or use Down arrow to focus the text. Escape or an outside
        click closes it.
      </span>
      <section
        ref={content}
        id={id}
        popover="manual"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className="editor-help-content"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          maxHeight: position?.maxHeight,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        <h4 id={`${id}-title`}>{label}</h4>
        {children}
      </section>
    </div>
  );
}
