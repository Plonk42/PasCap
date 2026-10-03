import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/shared/model.js';
import { projectAudioIds, projectVideoIds } from '../../src/shared/projects.js';

describe('project media membership', () => {
  it('starts empty without inheriting another project bin', () => {
    const first = createProject('first', 'First'); first.media.videoIds.push('video'); first.media.audioIds.push('music');
    const second = createProject('second', 'Second');
    expect([...projectVideoIds(second)]).toEqual([]); expect([...projectAudioIds(second)]).toEqual([]);
  });

  it('includes imported unused sources and timeline references once, without changing the document', () => {
    const project = createProject('first', 'First');
    project.media = { videoIds: ['unused', 'shared'], audioIds: ['unused-audio', 'music'] };
    project.clips = [createClip('one', 'shared', 0, 10), createClip('two', 'timeline', 0, 10)];
    project.music = { mediaId: 'music', sourceIn: 0, sourceOut: 10, start: 0, duration: 10, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false };
    const before = JSON.stringify(project);
    expect([...projectVideoIds(project)]).toEqual(['unused', 'shared', 'timeline']);
    expect([...projectAudioIds(project)]).toEqual(['unused-audio', 'music']);
    projectVideoIds(project).clear(); expect(JSON.stringify(project)).toBe(before);
  });
});