import type { SourceFingerprint } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { musicClips } from '../shared/music-lanes.js';
import { validateSourceRanges } from '../shared/source-range.js';
import type { AudioLibrary } from './audio.js';
import { errorMessage, ServiceError } from './errors.js';
import { assertSourceIdentity } from './files.js';
import type { MediaLibrary } from './library.js';

/** Clips, kept ranges and music fit their registered recordings; no file is read. */
export function assertSourceRanges(
  document: ProjectDocument,
  library: Pick<MediaLibrary, 'get'>,
  audio: Pick<AudioLibrary, 'get'>,
): void {
  document.media.videoIds.forEach((id) => library.get(id));
  document.media.audioIds.forEach((id) => audio.get(id));
  const frameCounts = new Map(
    [...document.clips.map((clip) => clip.mediaId), ...Object.keys(document.selects)].map((mediaId) => {
      const asset = library.get(mediaId);
      return [asset.id, asset.metadata.frameCount] as const;
    }),
  );
  try {
    validateSourceRanges(document, frameCounts);
  } catch (error) {
    throw new ServiceError(errorMessage(error), 422);
  }
  for (const clip of document.clips) {
    if (clip.sourceOut > library.get(clip.mediaId).metadata.frameCount)
      throw new ServiceError(`Clip ${clip.id} exceeds its registered source frames.`, 422);
  }
  for (const track of musicClips(document.music)) {
    if (track.sourceOut > audio.get(track.mediaId).metadata.frameCount)
      throw new ServiceError('Music exceeds its registered source frames.', 422);
  }
}

/** Saved projects may only reference registered, unchanged recordings and music within their frames. */
export async function assertProjectSources(
  document: ProjectDocument,
  library: Pick<MediaLibrary, 'get'>,
  audio: Pick<AudioLibrary, 'get'>,
): Promise<void> {
  assertSourceRanges(document, library, audio);
  const sources = new Map<string, { sourcePath: string; fingerprint: SourceFingerprint }>();
  for (const clip of document.clips) {
    const asset = library.get(clip.mediaId);
    sources.set(`video:${asset.id}`, asset);
  }
  for (const track of musicClips(document.music)) {
    const asset = audio.get(track.mediaId);
    sources.set(`audio:${asset.id}`, asset);
  }
  await [...sources.values()].reduce(async (previous, asset) => {
    await previous;
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
  }, Promise.resolve());
}
