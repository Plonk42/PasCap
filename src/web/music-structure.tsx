import { musicSourceFrame } from '../shared/audio.js';
import type { MusicTrack } from '../shared/model.js';
import {
  musicBeatFrames,
  musicHitFrames,
  musicSpans,
  type MusicAnalysis,
  type PlacedSpan,
} from '../shared/music-analysis.js';
import { MUSIC_SAMPLE_RATE, MUSIC_SAMPLES_PER_FRAME } from '../shared/music-format.js';
import { formatTimecode } from '../shared/timing.js';

/** Loudness is measured every 100 ms, tone every second. */
const LOUDNESS_SAMPLES = MUSIC_SAMPLE_RATE / 10;
const TONE_BANDS = ['low', 'mid', 'high'] as const;
/** Each tone band is drawn over the 40 dB below its loudest second, in six steps. */
const TONE_RANGE_DB = 40;
const TONE_STEPS = 6;
const SECTION_LABEL_MIN_PX = 40;
const SWELL_MIN_PX = 6;

interface Stretch {
  fromSample: number;
  toSample: number;
}
interface Placed<T> {
  item: T;
  span: PlacedSpan;
}

/** Each stretch where it plays in the clip, once per loop, in timeline order. */
function placeAll<T extends Stretch>(music: MusicTrack, items: readonly T[]): Placed<T>[] {
  return items
    .flatMap((item) => musicSpans(music, item.fromSample, item.toSample).map((span) => ({ item, span })))
    .sort((left, right) => left.span.start - right.span.start);
}

const decibels = (value: number): string => {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)} dB`;
};
const signedDecibels = (value: number): string => `${value < 0 ? '−' : '+'}${Math.abs(Math.round(value))} dB`;

function sampleAt(music: MusicTrack, frame: number): number | null {
  const source = musicSourceFrame(music, frame);
  return source === null ? null : source * MUSIC_SAMPLES_PER_FRAME;
}

function toneText(tone: readonly number[] | undefined): string {
  return tone ? TONE_BANDS.map((band, index) => `${band} ${decibels(tone[index]!)}`).join(' · ') : '';
}

/** "strong low hit": a hit's strength and band. */
const hitText = (hit: { strong: boolean; band: string }): string =>
  `${hit.strong ? 'strong' : 'light'} ${hit.band} hit`;

/** The item nearest `frame` within `reach` frames. */
function nearest<T extends { frame: number }>(items: readonly T[], frame: number, reach: number): T | undefined {
  let found: T | undefined;
  for (const item of items)
    if (
      Math.abs(item.frame - frame) <= reach &&
      (!found || Math.abs(item.frame - frame) < Math.abs(found.frame - frame))
    )
      found = item;
  return found;
}

/** What plays at a project frame of the clip, with a beat or hit within `reach` frames: the hover readout. */
export function describeMusicMoment(music: MusicTrack, analysis: MusicAnalysis, frame: number, reach = 0): string {
  const sample = sampleAt(music, frame);
  if (sample === null) return formatTimecode(frame);
  const inside = (stretch: Stretch): boolean => sample >= stretch.fromSample && sample < stretch.toSample;
  const parts = [formatTimecode(frame)];
  const beat = nearest(musicBeatFrames(music, analysis.beats), frame, reach);
  if (beat) parts.push(beat.downbeat ? 'downbeat' : 'beat');
  const hit = nearest(musicHitFrames(music, analysis.hits), frame, reach);
  if (hit) parts.push(hitText(hit));
  const section = analysis.sections.find(inside);
  if (section) parts.push(section.kind);
  const silent = analysis.silences.some(inside);
  const loudness = analysis.loudness[Math.floor(sample / LOUDNESS_SAMPLES)];
  if (silent) parts.push('silence');
  else if (loudness !== undefined) parts.push(decibels(loudness));
  const swell = analysis.swells.find(inside);
  if (swell) parts.push(`${swell.sudden ? 'sudden ' : ''}${swell.kind}`);
  const tone = toneText(analysis.tone[Math.floor(sample / MUSIC_SAMPLE_RATE)]);
  if (tone && !silent) parts.push(tone);
  return parts.join(' · ');
}

/** One path per band and step: columns across the clip, brighter where the band is louder. */
function tonePaths(music: MusicTrack, analysis: MusicAnalysis, columns: number): { d: string; className: string }[] {
  const ceilings = TONE_BANDS.map((_, band) => Math.max(...analysis.tone.map((second) => second[band]!)));
  const paths = TONE_BANDS.flatMap((band) =>
    Array.from({ length: TONE_STEPS }, (_, step) => ({ d: '', className: `${band} step-${step + 1}` })),
  );
  for (let column = 0; column < columns; column++) {
    const sample = sampleAt(music, music.start + Math.floor(((column + 0.5) / columns) * music.duration));
    const tone = sample === null ? undefined : analysis.tone[Math.floor(sample / MUSIC_SAMPLE_RATE)];
    if (!tone) continue;
    TONE_BANDS.forEach((_, band) => {
      const level = (tone[band]! - ceilings[band]! + TONE_RANGE_DB) / TONE_RANGE_DB;
      const step = Math.min(TONE_STEPS, Math.ceil(level * TONE_STEPS));
      if (step >= 1) paths[band * TONE_STEPS + step - 1]!.d += `M${column} ${band}h1v1h-1Z`;
    });
  }
  return paths.filter((path) => path.d);
}

function swellPath({ span, item }: Placed<MusicAnalysis['swells'][number]>, music: MusicTrack, scale: number): string {
  const from = (span.start - music.start) * scale;
  const to = Math.max(from + SWELL_MIN_PX, (span.end - music.start) * scale);
  if (item.sudden) return item.kind === 'crescendo' ? `M${from} 5L${to} 1V9Z` : `M${from} 1L${to} 5L${from} 9Z`;
  return item.kind === 'crescendo' ? `M${to} 1L${from} 5L${to} 9` : `M${from} 1L${to} 5L${from} 9`;
}

/**
 * Sections, silences, swells and tone of a music clip's analysis, where they play now:
 * bands behind the waveform, hairpins along the top and a three-band tone strip below.
 */
export function MusicStructure({
  music,
  analysis,
  scale,
}: Readonly<{ music: MusicTrack; analysis: MusicAnalysis; scale: number }>) {
  const width = music.duration * scale;
  const box = (span: PlacedSpan) => ({
    left: (span.start - music.start) * scale,
    width: (span.end - span.start) * scale,
  });
  const swells = placeAll(music, analysis.swells).filter(
    ({ span, item }) => item.sudden || (span.end - span.start) * scale >= SWELL_MIN_PX,
  );
  const columns = Math.max(1, Math.min(600, Math.round(width / 3)));
  const tone = analysis.tone.length ? tonePaths(music, analysis, columns) : [];
  return (
    <>
      {placeAll(music, analysis.sections).map(({ item, span }) => (
        <div
          key={`section-${span.start}`}
          className={`music-section ${item.kind}`}
          aria-hidden="true"
          data-section={item.kind}
          data-start={span.start}
          data-end={span.end}
          style={box(span)}
        >
          {box(span).width >= SECTION_LABEL_MIN_PX && <span>{item.kind}</span>}
        </div>
      ))}
      {placeAll(music, analysis.silences).map(({ span }) => (
        <div
          key={`silence-${span.start}`}
          className="music-silence"
          aria-hidden="true"
          data-silence={span.start}
          data-end={span.end}
          style={box(span)}
        />
      ))}
      {swells.length > 0 && (
        <svg className="music-swells" aria-hidden="true" width={width} height={10} viewBox={`0 0 ${width} 10`}>
          {swells.map((swell) => (
            <path
              key={`swell-${swell.span.start}`}
              className={`${swell.item.kind}${swell.item.sudden ? ' sudden' : ''}`}
              data-swell={swell.item.kind}
              data-sudden={swell.item.sudden}
              data-start={swell.span.start}
              d={swellPath(swell, music, scale)}
            />
          ))}
        </svg>
      )}
      {tone.length > 0 && (
        <svg
          className="music-tone"
          aria-hidden="true"
          viewBox={`0 0 ${columns} 3`}
          preserveAspectRatio="none"
          data-columns={columns}
        >
          {tone.map((path) => (
            <path key={path.className} className={path.className} d={path.d} />
          ))}
        </svg>
      )}
    </>
  );
}

function sectionTone(analysis: MusicAnalysis, section: Stretch): number[] | undefined {
  const seconds = analysis.tone.slice(
    Math.floor(section.fromSample / MUSIC_SAMPLE_RATE),
    Math.ceil(section.toSample / MUSIC_SAMPLE_RATE),
  );
  if (!seconds.length) return undefined;
  return TONE_BANDS.map((_, band) => seconds.reduce((total, second) => total + second[band]!, 0) / seconds.length);
}

function StructureItem({
  frame,
  text,
  onSeek,
}: Readonly<{ frame: number; text: string; onSeek: (frame: number) => void }>) {
  return (
    <li>
      <button
        type="button"
        className="text-button"
        title={`Go to ${formatTimecode(frame)}`}
        onClick={() => onSeek(frame)}
      >
        {formatTimecode(frame)}
      </button>
      <span>{text}</span>
    </li>
  );
}

/** The clip's sections, swells, silences and strong hits at their timeline positions, for reading and keyboard access. */
export function MusicStructureList({
  music,
  analysis,
  onSeek,
}: Readonly<{ music: MusicTrack; analysis: MusicAnalysis; onSeek: (frame: number) => void }>) {
  const sections = placeAll(music, analysis.sections);
  const swells = placeAll(music, analysis.swells);
  const silences = placeAll(music, analysis.silences);
  const hits = musicHitFrames(music, analysis.hits).filter((hit) => hit.strong);
  if (!sections.length && !swells.length && !silences.length && !hits.length) return null;
  return (
    <details className="music-structure">
      <summary>Music structure</summary>
      {sections.length > 0 && (
        <section aria-label="Sections">
          <h4>Sections</h4>
          <ul>
            {sections.map(({ item, span }) => (
              <StructureItem
                key={`section-${span.start}`}
                frame={span.start}
                onSeek={onSeek}
                text={[
                  `${item.kind} to ${formatTimecode(span.end)}`,
                  decibels(item.loudnessDb),
                  toneText(sectionTone(analysis, item)),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </ul>
        </section>
      )}
      {swells.length > 0 && (
        <section aria-label="Swells">
          <h4>Swells</h4>
          <ul>
            {swells.map(({ item, span }) => (
              <StructureItem
                key={`swell-${span.start}`}
                frame={span.start}
                onSeek={onSeek}
                text={`${item.sudden ? 'Sudden ' : ''}${item.kind} ${signedDecibels(item.changeDb)} to ${formatTimecode(span.end)}`}
              />
            ))}
          </ul>
        </section>
      )}
      {silences.length > 0 && (
        <section aria-label="Silences">
          <h4>Silences</h4>
          <ul>
            {silences.map(({ span }) => (
              <StructureItem
                key={`silence-${span.start}`}
                frame={span.start}
                onSeek={onSeek}
                text={`Silence to ${formatTimecode(span.end)}`}
              />
            ))}
          </ul>
        </section>
      )}
      {hits.length > 0 && (
        <section aria-label="Strong hits">
          <h4>Strong hits</h4>
          <ul>
            {hits.map((hit) => (
              <StructureItem
                key={`hit-${hit.frame}`}
                frame={hit.frame}
                onSeek={onSeek}
                text={`${hit.band[0]!.toUpperCase()}${hit.band.slice(1)} hit`}
              />
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}
