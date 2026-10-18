import type { DamagedRange } from '../shared/media.js';

/** Damaged source frames, shown black, positioned over a strip of `count` frames. */
export function DamageMarks({
  damage,
  count,
  className,
}: Readonly<{ damage: readonly DamagedRange[]; count: number; className: string }>) {
  return damage.map((range) => (
    <span
      key={range.start}
      className={className}
      style={{ left: `${(range.start / count) * 100}%`, width: `${((range.end - range.start) / count) * 100}%` }}
      aria-hidden="true"
    />
  ));
}
