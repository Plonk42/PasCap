import { useEffect, useRef, useState, type PointerEvent } from 'react';

export interface WorkspaceLayout {
  mediaWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
  mediaOpen: boolean;
  inspectorOpen: boolean;
}
export const DEFAULT_LAYOUT: Readonly<WorkspaceLayout> = Object.freeze({
  mediaWidth: 300,
  inspectorWidth: 320,
  timelineHeight: 290,
  mediaOpen: true,
  inspectorOpen: true,
});
const STORAGE_KEY = 'pascap-workspace-layout';
export function clampSize(value: number, min: number, max: number): number {
  return Math.max(Math.ceil(min), Math.min(Math.floor(max), Math.round(value)));
}
export function validLayout(value: unknown): value is WorkspaceLayout {
  if (typeof value !== 'object' || value === null) return false;
  const layout = value as Record<string, unknown>;
  return (
    ['mediaWidth', 'inspectorWidth', 'timelineHeight'].every(
      (key) =>
        typeof layout[key] === 'number' &&
        Number.isFinite(layout[key]) &&
        Number(layout[key]) >= 180 &&
        Number(layout[key]) <= 600,
    ) &&
    typeof layout['mediaOpen'] === 'boolean' &&
    typeof layout['inspectorOpen'] === 'boolean'
  );
}
export function workspaceSizes(layout: WorkspaceLayout, width: number, height: number) {
  return {
    media: clampSize(layout.mediaWidth, 240, Math.max(240, Math.min(440, width * 0.29))),
    inspector: clampSize(layout.inspectorWidth, 270, Math.max(270, Math.min(440, width * 0.3))),
    timeline: clampSize(layout.timelineHeight, 200, Math.max(200, Math.min(520, height - 360))),
  };
}
export function useWorkspace() {
  const [layout, setLayout] = useState<WorkspaceLayout>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (validLayout(saved))
        return { ...saved, inspectorOpen: saved.inspectorOpen && (window.innerWidth >= 980 || !saved.mediaOpen) };
    } catch {
      /* Unavailable UI preferences never prevent opening a project. */
    }
    return { ...DEFAULT_LAYOUT, inspectorOpen: window.innerWidth >= 980 };
  });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [storageError, setStorageError] = useState('');
  useEffect(() => {
    const resized = (): void => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      // Narrow desktops use one side drawer at a time. This adaptation does not
      // overwrite the user's saved desktop dimensions or visibility preference.
      if (window.innerWidth < 980)
        setLayout((current) =>
          current.mediaOpen && current.inspectorOpen ? { ...current, inspectorOpen: false } : current,
        );
    };
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  const latest = useRef(layout);
  latest.current = layout;
  const update = (changes: Partial<WorkspaceLayout>, persist = true): void => {
    const next = { ...latest.current, ...changes };
    latest.current = next;
    setLayout(next);
    if (!persist) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setStorageError('');
    } catch {
      setStorageError('Layout changed for this session; browser storage is unavailable.');
    }
  };
  return {
    layout,
    update,
    sizes: workspaceSizes(layout, viewport.width, viewport.height),
    viewport,
    storageError,
    reset: () => update({ ...DEFAULT_LAYOUT, inspectorOpen: viewport.width >= 980 }),
  };
}

interface ResizeProps {
  label: string;
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  direction?: 1 | -1;
  defaultValue: number;
  onChange: (value: number, persist: boolean) => void;
  className: string;
  disabled?: boolean;
}
export function WorkspaceResizer({
  label,
  orientation,
  value,
  min,
  max,
  direction = 1,
  defaultValue,
  onChange,
  className,
  disabled = false,
}: Readonly<ResizeProps>) {
  const active = useRef<{ pointer: number; origin: number; value: number; next: number } | null>(null);
  const cancel = (): void => {
    const drag = active.current;
    if (!drag) return;
    active.current = null;
    onChange(drag.value, false);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !active.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });
  const coordinate = (event: PointerEvent<HTMLButtonElement>): number =>
    orientation === 'vertical' ? event.clientX : event.clientY;
  return (
    <button
      type="button"
      className={`workspace-resizer ${className}`}
      role="slider"
      disabled={disabled}
      aria-label={label}
      aria-orientation={orientation}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      style={{ padding: 0, minWidth: 0, minHeight: 0 }}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      title="Drag to resize · arrows adjust · double-click to reset · Esc cancels"
      onDoubleClick={() => {
        if (!disabled) onChange(clampSize(defaultValue, min, max), true);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || disabled) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        active.current = { pointer: event.pointerId, origin: coordinate(event), value, next: value };
      }}
      onPointerMove={(event) => {
        const drag = active.current;
        if (drag?.pointer !== event.pointerId) return;
        drag.next = clampSize(drag.value + (coordinate(event) - drag.origin) * direction, min, max);
        onChange(drag.next, false);
      }}
      onPointerUp={(event) => {
        const drag = active.current;
        if (drag?.pointer !== event.pointerId) return;
        active.current = null;
        onChange(drag.next, true);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (disabled) return;
        const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
        const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
        if (event.key === 'Home') {
          event.preventDefault();
          onChange(clampSize(defaultValue, min, max), true);
        }
        if (event.key !== decrease && event.key !== increase) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(
          clampSize(value + (event.key === decrease ? -1 : 1) * direction * (event.shiftKey ? 32 : 16), min, max),
          true,
        );
      }}
    >
      <span />
    </button>
  );
}
