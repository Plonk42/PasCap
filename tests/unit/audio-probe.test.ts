import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAudio } from '../../src/server/audio.js';
import { createConfig } from '../../src/server/config.js';
import * as processes from '../../src/server/process.js';

const audio = { codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2, duration: '2' };

describe('standalone music stream validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests attached-picture disposition and accepts embedded artwork without changing audio metadata', async () => {
    const run = vi.spyOn(processes, 'runProcess').mockResolvedValue(Buffer.from(JSON.stringify({
      streams: [audio, { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }],
    })));
    const config = createConfig();
    await expect(probeAudio(config, '/synthetic/music.mp3')).resolves.toEqual({
      codec: 'mp3', sampleRate: 44100, channels: 2, durationSeconds: 2, frameCount: 59,
    });
    expect(run.mock.calls[0]![1]).toContain('stream=codec_type,codec_name,sample_rate,channels,duration,duration_ts,time_base:stream_disposition=attached_pic:format=duration');
  });

  it.each([
    { name: 'ordinary video', streams: [audio, { codec_type: 'video', disposition: { attached_pic: 0 } }] },
    { name: 'unmarked image', streams: [audio, { codec_type: 'video', codec_name: 'mjpeg' }] },
    { name: 'artwork plus actual video', streams: [audio, { codec_type: 'video', disposition: { attached_pic: 1 } }, { codec_type: 'video', disposition: { attached_pic: 0 } }] },
    { name: 'two audio streams plus artwork', streams: [audio, audio, { codec_type: 'video', disposition: { attached_pic: 1 } }] },
    { name: 'artwork without audio', streams: [{ codec_type: 'video', disposition: { attached_pic: 1 } }] },
  ])('rejects $name', async ({ streams }) => {
    vi.spyOn(processes, 'runProcess').mockResolvedValue(Buffer.from(JSON.stringify({ streams })));
    await expect(probeAudio(createConfig(), '/synthetic/source')).rejects.toThrow('exactly one audio stream');
  });

  it.each([true, '1', 2, null])('rejects malformed attached-picture flags (%s)', async (attached_pic) => {
    vi.spyOn(processes, 'runProcess').mockResolvedValue(Buffer.from(JSON.stringify({
      streams: [audio, { codec_type: 'video', disposition: { attached_pic } }],
    })));
    await expect(probeAudio(createConfig(), '/synthetic/source')).rejects.toThrow();
  });
});
