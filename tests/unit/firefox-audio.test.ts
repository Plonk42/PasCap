import { describe, expect, it } from 'vitest';
import { requireFirefoxAudio, type FirefoxAudioReadiness } from '../../scripts/ci/firefox-audio.js';

const ready: FirefoxAudioReadiness = {
    state: 'running', sampleRate: 48_000, renderedFrames: 4096,
    invalidSamples: 0, renderedTime: 0.1, outputTime: 0.11, error: '',
};

describe('Firefox audio prerequisite', () => {
    it('accepts real stereo rendering presented by the output clock', () => {
        expect(() => requireFirefoxAudio(ready)).not.toThrow();
    });

    it.each([
        { state: 'suspended' },
        { sampleRate: 44_100 },
        { renderedFrames: 0 },
        { renderedFrames: 4096.5 },
        { invalidSamples: 1 },
        { renderedTime: 0 },
        { renderedTime: Number.NaN },
        { outputTime: 0 },
        { outputTime: 0.09 },
        { outputTime: Number.NaN },
        { error: 'Actual audio prerequisite processor failed.' },
    ])('fails explicitly on unavailable/broken real audio evidence: %j', (failure) => {
        const result = { ...ready, ...failure };
        expect(() => requireFirefoxAudio(result)).toThrow('Firefox audio prerequisite failed.');
        expect(() => requireFirefoxAudio(result)).toThrow('pulseaudio');
        expect(() => requireFirefoxAudio(result)).toThrow(JSON.stringify(result));
    });
});