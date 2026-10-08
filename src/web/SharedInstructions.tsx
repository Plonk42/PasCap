/** One description per input pattern, referenced by every control instead of repeated per control. */
export const NUMBER_FIELD_INSTRUCTIONS_ID = 'pascap-number-field-instructions';
export const SLIDER_INSTRUCTIONS_ID = 'pascap-slider-instructions';
export const HELP_INSTRUCTIONS_ID = 'pascap-help-instructions';

export function SharedInstructions() {
  return (
    <div hidden>
      <span id={NUMBER_FIELD_INSTRUCTIONS_ID}>
        Enter or leave the field to apply. Escape restores the current value.
      </span>
      <span id={SLIDER_INSTRUCTIONS_ID}>
        Drag to choose a value; release to apply once. Escape cancels the drag. Exact values apply on Enter or blur.
      </span>
      <span id={HELP_INSTRUCTIONS_ID}>
        Hover or focus to read help. Click to keep it open, or use Down arrow to focus the text. Escape or an outside
        click closes it.
      </span>
    </div>
  );
}
