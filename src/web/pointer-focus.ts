/** Remembers which elements took focus from a pointer press, so Space can play instead of activating them. */
export interface PointerFocus {
  byPointer: (element: Element) => boolean;
  dispose: () => void;
}

export function trackPointerFocus(root: Document): PointerFocus {
  const focused = new WeakSet<Element>();
  let pressing = false;
  let presses = 0;
  const press = (event: PointerEvent): void => {
    pressing = true;
    presses++;
    const active = root.activeElement;
    // Pressing the control that already has focus hands it to the pointer too.
    if (active && event.target instanceof Node && active.contains(event.target)) focused.add(active);
  };
  const release = (): void => {
    const released = presses;
    // A label focuses its control after the click that follows pointerup.
    setTimeout(() => {
      if (released === presses) pressing = false;
    });
  };
  const key = (): void => {
    pressing = false;
  };
  const focus = (event: FocusEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (pressing) focused.add(event.target);
    else focused.delete(event.target);
  };
  root.addEventListener('pointerdown', press, true);
  root.addEventListener('pointerup', release, true);
  root.addEventListener('pointercancel', release, true);
  root.addEventListener('keydown', key, true);
  root.addEventListener('focusin', focus, true);
  return {
    byPointer: (element) => focused.has(element),
    dispose: () => {
      root.removeEventListener('pointerdown', press, true);
      root.removeEventListener('pointerup', release, true);
      root.removeEventListener('pointercancel', release, true);
      root.removeEventListener('keydown', key, true);
      root.removeEventListener('focusin', focus, true);
    },
  };
}
