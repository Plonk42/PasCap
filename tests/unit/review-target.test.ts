import { describe, expect, it, vi } from 'vitest';
import type { SourcePlayback } from '../../src/web/SourceReview.js';
import { reviewControls } from '../../src/web/use-review-target.js';

function setup(shownMedia: () => string | null) {
  const show = vi.fn((mediaId: string) => mediaId === shownMedia());
  const playback = { current: { toggle: vi.fn(), show } satisfies SourcePlayback };
  const setReview = vi.fn();
  return { show, setReview, controls: reviewControls(playback, setReview) };
}

describe('review target controls', () => {
  it('moves within the rendered recording without a render, and opens another one through React', () => {
    let rendered: string | null = null;
    const { show, setReview, controls } = setup(() => rendered);
    controls.source({ mediaId: 'a', frame: 3 }, false);
    expect(setReview).toHaveBeenLastCalledWith({ mediaId: 'a', frame: 3 });
    rendered = 'a';
    controls.source({ mediaId: 'a', frame: 9 }, false);
    expect(show).toHaveBeenLastCalledWith('a', 9);
    expect(setReview).toHaveBeenCalledTimes(1);
    expect(controls.current()).toEqual({ mediaId: 'a', frame: 9 });
  });

  it('never seeks the rendered recording while React has another one pending', () => {
    const { show, setReview, controls } = setup(() => 'a');
    controls.source({ mediaId: 'a', frame: 1 }, false);
    controls.source({ mediaId: 'b', frame: 2 }, false);
    show.mockClear();
    controls.source({ mediaId: 'a', frame: 4 }, false);
    expect(show).not.toHaveBeenCalled();
    expect(setReview).toHaveBeenLastCalledWith({ mediaId: 'a', frame: 4 });
  });

  it('returns to the chosen recording at its last displayed frame once hovering ends', () => {
    const { show, setReview, controls } = setup(() => 'a');
    controls.source({ mediaId: 'a', frame: 5 }, true);
    controls.displayed({ mediaId: 'a', frame: 7 });
    controls.source({ mediaId: 'a', frame: 40 }, false);
    controls.displayed({ mediaId: 'a', frame: 40 });
    controls.endHover();
    expect(show).toHaveBeenLastCalledWith('a', 7);
    controls.source({ mediaId: 'b', frame: 2 }, false);
    controls.endHover();
    expect(setReview).toHaveBeenLastCalledWith({ mediaId: 'a', frame: 7 });
  });

  it('closes a removed recording and forgets a removed choice', () => {
    const { setReview, controls } = setup(() => 'a');
    controls.source({ mediaId: 'a', frame: 5 }, true);
    expect(controls.remove(['b'])).toBe(false);
    expect(controls.remove(['a'])).toBe(true);
    expect(setReview).toHaveBeenLastCalledWith(null);
    controls.source({ mediaId: 'b', frame: 1 }, false);
    controls.endHover();
    expect(controls.current()).toEqual({ mediaId: 'b', frame: 1 });
  });
});
