import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import {
  createClip,
  createProject,
  projectSchema,
  type MusicTrack,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { mediaRemovalUsage, projectAudioIds, projectVideoIds, removeProjectMedia } from '../../src/shared/projects.js';
import { arrangeMusicLane, setMusicRipple } from '../../src/shared/music-lanes.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { singleClipLane } from '../music-lanes.js';

describe('project media membership', () => {
  it('starts empty without inheriting another project bin', () => {
    const first = createProject('first', 'First');
    first.media.videoIds.push('video');
    first.media.audioIds.push('music');
    const second = createProject('second', 'Second');
    expect([...projectVideoIds(second)]).toEqual([]);
    expect([...projectAudioIds(second)]).toEqual([]);
  });

  it('includes imported unused sources and timeline references once, without changing the document', () => {
    const project = createProject('first', 'First');
    project.media = { videoIds: ['unused', 'shared'], audioIds: ['unused-audio', 'music'] };
    project.clips = [createClip('one', 'shared', 0, 10), createClip('two', 'timeline', 0, 10)];
    const placement = {
      id: 'music-instance',
      mediaId: 'music',
      sourceIn: 0,
      sourceOut: 10,
      start: 0,
      duration: 10,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    };
    project.music = [
      singleClipLane(placement),
      singleClipLane({ ...placement, id: 'reused-instance', start: 20 }),
      singleClipLane({ ...placement, id: 'other-instance', mediaId: 'timeline-audio', start: 40 }),
    ];
    const before = JSON.stringify(project);
    expect([...projectVideoIds(project)]).toEqual(['unused', 'shared', 'timeline']);
    expect([...projectAudioIds(project)]).toEqual(['unused-audio', 'music', 'timeline-audio']);
    projectVideoIds(project).clear();
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('removing recordings from the project bin', () => {
  const music = (id: string, mediaId: string, start: number): MusicTrack => ({
    id,
    mediaId,
    sourceIn: 0,
    sourceOut: 30,
    start,
    duration: 30,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  });
  function binProject(ripple = true): ProjectDocument {
    let project = createProject('bin', 'Bin');
    project.layers[0] = { ...project.layers[0]!, ripple };
    project.media = { videoIds: ['a', 'b', 'unused'], audioIds: ['song', 'other-song', 'quiet'] };
    for (const [index, [id, mediaId]] of [
      ['a1', 'a'],
      ['b1', 'b'],
      ['a2', 'a'],
    ].entries())
      project = applyCommand(project, {
        type: 'insert',
        clip: { ...createClip(id!, mediaId!, 0, 30, project.layers[0]!.id), start: index * 40 },
        index,
      });
    return projectSchema.parse({
      ...project,
      music: [music('m1', 'song', 0), music('m2', 'other-song', 10), music('m3', 'song', 40)].map((track) =>
        singleClipLane(track),
      ),
    });
  }

  it('removes only an unused recording’s membership without changing placements or the input', () => {
    const project = binProject();
    const before = JSON.stringify(project);
    const removal = { videoIds: ['unused'], audioIds: ['quiet'] };
    expect(mediaRemovalUsage(project, removal)).toEqual({ clips: 0, music: 0 });
    const next = removeProjectMedia(project, removal);
    expect(next.media).toEqual({ videoIds: ['a', 'b'], audioIds: ['song', 'other-song'] });
    expect(next.clips).toEqual(project.clips);
    expect(next.music).toEqual(project.music);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('removes a used recording with all of its excerpts and music instances atomically', () => {
    const project = binProject();
    const removal = { videoIds: ['a'], audioIds: ['song'] };
    expect(mediaRemovalUsage(project, removal)).toEqual({ clips: 2, music: 2 });
    const next = removeProjectMedia(project, removal);
    expect(next.clips.map((clip) => clip.id)).toEqual(['b1']);
    // Ripple closes the removed excerpts' gap exactly like deleting them one by one.
    expect(calculateLayout(next).clips[0]!.start).toBe(0);
    expect(next.layers[0]!.transitions).toEqual([]);
    expect(next.music.map((track) => track.id)).toEqual(['m2-track']);
    expect([...projectVideoIds(next)]).toEqual(['b', 'unused']);
    expect([...projectAudioIds(next)]).toEqual(['other-song', 'quiet']);
  });

  it('keeps independent placements on a positioned row', () => {
    const project = binProject(false);
    const next = removeProjectMedia(project, { videoIds: ['a'], audioIds: [] });
    expect(next.clips.map((clip) => [clip.id, clip.start])).toEqual([['b1', 40]]);
    expect(next.music).toEqual(project.music);
  });

  it('removes only the clips of a removed recording from a music track, keeping its other clips', () => {
    const project = binProject();
    const clip = (id: string, mediaId: string, start: number) => singleClipLane(music(id, mediaId, start)).clips[0]!;
    const mixed = setMusicRipple(
      arrangeMusicLane({ ...singleClipLane(music('mix', 'song', 0)), clips: [], transitions: [] }, [
        clip('mix-a', 'song', 0),
        clip('mix-b', 'other-song', 30),
        clip('mix-c', 'song', 60),
      ]),
      true,
    );
    const withMix = projectSchema.parse({ ...project, music: [...project.music, mixed] });
    expect(mediaRemovalUsage(withMix, { videoIds: [], audioIds: ['song'] })).toEqual({ clips: 0, music: 4 });
    const next = removeProjectMedia(withMix, { videoIds: [], audioIds: ['song'] });
    expect(next.music.map((track) => track.id)).toEqual(['m2-track', 'mix-track']);
    // A Ripple music track closes the gap from its first start, like a video track.
    expect(next.music[1]!.clips.map((clip) => [clip.id, clip.start])).toEqual([['mix-b', 0]]);
    expect(next.music[1]!.transitions).toEqual([]);
  });

  it('rejects recordings outside the bin and empty removals without partial changes', () => {
    const project = binProject();
    expect(() => removeProjectMedia(project, { videoIds: ['a', 'elsewhere'], audioIds: [] })).toThrow(
      'belong to this project',
    );
    expect(() => removeProjectMedia(project, { videoIds: [], audioIds: [] })).toThrow('belong to this project');
    expect(() => removeProjectMedia(project, { videoIds: ['song'], audioIds: [] })).toThrow('belong to this project');
  });
});
