import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './declutter.css';
import { Icon } from './icons.js';
import { popoverPosition, type PopoverPosition } from './popover-position.js';

interface Props {
  label: string;
  className?: string;
  trigger?: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** A nonmodal disclosure: normal Tab order, not an incomplete ARIA menu. */
export function Popover({ label, className = '', trigger: triggerContent, children }: Readonly<Props>) {
  const contentId = useId();
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const content = useRef<HTMLFieldSetElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const close = useCallback((restoreFocus = true): void => {
    if (content.current?.matches(':popover-open')) content.current.hidePopover();
    setOpen(false);
    setPosition(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const place = useCallback((): void => {
    if (!trigger.current || !content.current) return;
    const panel = content.current.getBoundingClientRect();
    const height = panel.height + Math.max(0, content.current.scrollHeight - content.current.clientHeight);
    const next = popoverPosition(
      trigger.current.getBoundingClientRect(),
      { width: panel.width, height },
      { width: innerWidth, height: innerHeight },
    );
    setPosition((previous) =>
      previous?.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight
        ? previous
        : next,
    );
  }, []);

  // The native top layer escapes clipping AND size-container fixed-position containing blocks.
  // The details disclosure still owns expansion, focus and normal keyboard navigation.
  useLayoutEffect(() => {
    if (open) {
      if (!content.current?.matches(':popover-open')) content.current?.showPopover();
      place();
    } else if (content.current?.matches(':popover-open')) content.current.hidePopover();
  }, [open, children, place]);
  useEffect(() => {
    if (!open) return;
    const outsideClick = (event: globalThis.MouseEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    const keyboard = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const inside = event.target instanceof Node && root.current?.contains(event.target);
      // React fields can consume Escape first to cancel their own draft.
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (inside || event.key === 'Escape') event.stopPropagation();
    };
    const observer = new ResizeObserver(place);
    if (content.current) observer.observe(content.current);
    document.addEventListener('click', outsideClick);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', outsideClick);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, close, place]);

  return (
    <details
      ref={root}
      className={`editor-popover ${className}`}
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        if (expanded !== open) {
          setOpen(expanded);
          if (!expanded) setPosition(null);
        }
      }}
    >
      <summary
        ref={trigger}
        className="editor-popover-trigger icon-button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={(event) => {
          event.preventDefault();
          if (open) close();
          else setOpen(true);
        }}
      >
        {triggerContent ?? <Icon name="more" size={18} />}
      </summary>
      <fieldset
        ref={content}
        id={contentId}
        popover="manual"
        className="editor-popover-content"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          maxHeight: position?.maxHeight,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        <legend className="declutter-sr-only">{label}</legend>
        {typeof children === 'function' ? children(close) : children}
      </fieldset>
    </details>
  );
}
