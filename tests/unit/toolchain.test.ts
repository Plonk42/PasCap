import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { checkToolchain, listedNames, reportedVersion } from '../../src/server/toolchain.js';
import {
  QUALIFIED_FFMPEG,
  REQUIRED_FFMPEG,
  toolchainNotice,
  toolchainRelease,
  type Toolchain,
} from '../../src/shared/toolchain.js';

const ALL = {
  encoders: [...REQUIRED_FFMPEG.encoder, 'mjpeg'],
  filters: [...REQUIRED_FFMPEG.filter, 'scale'],
  bsfs: [...REQUIRED_FFMPEG['bitstream filter'], 'h264_mp4toannexb'],
};

function program(version: string | null, error: string | null = null, command = 'ffmpeg'): Toolchain['ffmpeg'] {
  return { command, version, error };
}

function toolchain(version: string, missing: string[] = []): Toolchain {
  return { ffmpeg: program(version), ffprobe: program(version, null, 'ffprobe'), missing };
}

let directory: string;

/** A stand-in for ffmpeg/ffprobe that answers the check's questions like the real ones. */
async function fake(
  name: string,
  version: string,
  { encoders = ALL.encoders, filters = ALL.filters, bsfs = ALL.bsfs, fails = false } = {},
): Promise<string> {
  const outputs = {
    '-version': `${path.basename(name).split('-')[0]} version ${version} Copyright (c) 2000-2025 the FFmpeg developers\n`,
    '-encoders': `Encoders:\n V..... = Video\n ------\n${encoders.map((item) => ` V....D ${item.padEnd(20)} ${item}`).join('\n')}\n`,
    '-filters': `Filters:\n  T.. = Timeline support\n  ------\n${filters.map((item) => ` TS ${item.padEnd(16)} V->V  ${item}.`).join('\n')}\n`,
    '-bsfs': `Bitstream filters:\n${bsfs.join('\n')}\n`,
  };
  const file = path.join(directory, name);
  await writeFile(
    file,
    [
      `#!${process.execPath}`,
      `const outputs = ${JSON.stringify(outputs)};`,
      fails ? `process.stderr.write('libx264.so.164: cannot open shared object file\\n'); process.exit(127);` : '',
      'process.stdout.write(outputs[process.argv.find((argument) => argument in outputs)] ?? "");',
    ].join('\n'),
  );
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-toolchain-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('toolchain report', () => {
  it('reads the release a version names', () => {
    expect(toolchainRelease('8.0.1')).toBe('8.0.1');
    expect(toolchainRelease('8.0.1-3ubuntu2')).toBe('8.0.1');
    expect(toolchainRelease('n8.0.1')).toBe('8.0.1');
    expect(toolchainRelease('6.1.1-3ubuntu5')).toBe('6.1.1');
    expect(toolchainRelease('7.0.2-static')).toBe('7.0.2');
    expect(toolchainRelease('N-121345-g0123abcd')).toBeNull();
    expect(toolchainRelease(null)).toBeNull();
  });

  it('says nothing about the qualified release, whoever built it', () => {
    expect(toolchainNotice(toolchain(QUALIFIED_FFMPEG))).toBeNull();
    expect(toolchainNotice(toolchain(`${QUALIFIED_FFMPEG}-3ubuntu2`))).toBeNull();
  });

  it('warns about another release without blocking anything', () => {
    expect(toolchainNotice(toolchain('6.1.1-3ubuntu5'))).toEqual({
      severity: 'warning',
      message: `FFmpeg 6.1.1-3ubuntu5 and ffprobe 6.1.1-3ubuntu5 are not the tested ${QUALIFIED_FFMPEG}: preparation and export may differ or fail. Build FFmpeg ${QUALIFIED_FFMPEG} with npm run setup:ffmpeg and point PASCAP_FFMPEG and PASCAP_FFPROBE at it.`,
    });
    const mixed = { ...toolchain(QUALIFIED_FFMPEG), ffprobe: program('N-121345-g0123abcd', null, 'ffprobe') };
    expect(toolchainNotice(mixed)?.message).toMatch(/^ffprobe N-121345-g0123abcd is not the tested /);
  });

  it('names missing components and programs that cannot run as errors', () => {
    expect(toolchainNotice(toolchain('7.1.1', ['libx264 encoder', 'lut3d filter', 'setts bitstream filter']))).toEqual({
      severity: 'error',
      message: `FFmpeg 7.1.1 lacks the libx264 encoder, lut3d filter and setts bitstream filter: preparing recordings or exporting can fail. Build FFmpeg ${QUALIFIED_FFMPEG} with npm run setup:ffmpeg and point PASCAP_FFMPEG and PASCAP_FFPROBE at it.`,
    });
    const broken = { ...toolchain(QUALIFIED_FFMPEG), ffmpeg: program(null, 'was not found', '/opt/ffmpeg/bin/ffmpeg') };
    expect(toolchainNotice(broken)?.message).toMatch(
      /^FFmpeg cannot run: \/opt\/ffmpeg\/bin\/ffmpeg was not found\. Recordings cannot be prepared or exported; saved projects still open\./,
    );
  });

  it('parses version banners and component lists', () => {
    expect(reportedVersion('ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025\nbuilt with gcc\n', 'ffmpeg')).toBe(
      '8.0.1-3ubuntu2',
    );
    expect(reportedVersion('ffmpeg version 8.0.1 Copyright', 'ffprobe')).toBeNull();
    const encoders = listedNames(
      'Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264              libx264 H.264\n A....D aac                  AAC\n',
    );
    expect([...encoders].filter((name) => name !== '------')).toEqual(['libx264', 'aac']);
    // FFmpeg 6 prints its filter legend without a ------ line.
    const filters = listedNames(
      'Filters:\n  T.. = Timeline support\n  A = Audio input/output\n  | = Source or sink filter\n TSC lut3d             V->V       Adjust colors using a 3D LUT.\n ... anullsrc          |->A       Null audio source.\n',
    );
    expect([...filters]).toEqual(['lut3d', 'anullsrc']);
    expect(listedNames('Bitstream filters:\naac_adtstoasc\nsetts\n').has('setts')).toBe(true);
  });

  it('keeps the setup script on the same release and components', async () => {
    const script = await readFile(path.join(import.meta.dirname, '../../scripts/setup-ffmpeg.sh'), 'utf8');
    const list = (name: string) =>
      new RegExp(String.raw`^readonly ${name}=\((.*)\)$`, 'm').exec(script)?.[1]?.split(' ');
    expect(/^readonly VERSION=(.+)$/m.exec(script)?.[1]).toBe(QUALIFIED_FFMPEG);
    expect(list('ENCODERS')).toEqual(REQUIRED_FFMPEG.encoder);
    expect(list('FILTERS')).toEqual(REQUIRED_FFMPEG.filter);
    expect(list('BITSTREAM_FILTERS')).toEqual(REQUIRED_FFMPEG['bitstream filter']);
  });
});

describe('startup toolchain check', () => {
  it('records the versions of a complete toolchain', async () => {
    const config = {
      ffmpeg: await fake('ffmpeg', `${QUALIFIED_FFMPEG}-3ubuntu2`),
      ffprobe: await fake('ffprobe', `${QUALIFIED_FFMPEG}-3ubuntu2`),
    };
    const report = await checkToolchain(config);
    expect(report).toEqual({
      ffmpeg: program(`${QUALIFIED_FFMPEG}-3ubuntu2`, null, config.ffmpeg),
      ffprobe: program(`${QUALIFIED_FFMPEG}-3ubuntu2`, null, config.ffprobe),
      missing: [],
    });
    expect(toolchainNotice(report)).toBeNull();
  });

  it('lists the components an unexpected version lacks', async () => {
    const report = await checkToolchain({
      ffmpeg: await fake('ffmpeg-free', '6.1.1', {
        encoders: ['ffv1', 'aac', 'pcm_s16le'],
        filters: ALL.filters.filter((item) => item !== 'lut3d'),
        bsfs: ['h264_mp4toannexb'],
      }),
      ffprobe: await fake('ffprobe-free', '6.1.1'),
    });
    expect(report.ffmpeg).toMatchObject({ version: '6.1.1', error: null });
    expect(report.missing).toEqual(['libx264 encoder', 'lut3d filter', 'setts bitstream filter']);
    expect(toolchainNotice(report)?.severity).toBe('error');
  });

  it('reports executables that are missing, not executable or broken without throwing', async () => {
    const plain = path.join(directory, 'plain-file');
    await writeFile(plain, 'not a program');
    await chmod(plain, 0o644);
    const report = await checkToolchain({ ffmpeg: path.join(directory, 'absent', 'ffmpeg'), ffprobe: plain });
    expect(report.ffmpeg).toEqual(program(null, 'was not found', path.join(directory, 'absent', 'ffmpeg')));
    expect(report.ffprobe).toEqual(program(null, 'is not executable', plain));
    expect(report.missing).toEqual([]);
    const broken = await checkToolchain({
      ffmpeg: await fake('ffmpeg-broken', QUALIFIED_FFMPEG, { fails: true }),
      ffprobe: await fake('ffprobe-ok', QUALIFIED_FFMPEG),
    });
    expect(broken.ffmpeg.error).toBe('exited 127: libx264.so.164: cannot open shared object file');
    expect(toolchainNotice(broken)?.message).toContain(`ffmpeg-broken exited 127: libx264.so.164`);
  });

  it('serves the startup report with the service health', async () => {
    const report = toolchain('6.1.1');
    const config = createConfig({ dataDir: path.join(directory, 'service'), webDir: '/nonexistent-pascap-assets' });
    for (const [given, expected] of [
      [report, report],
      [undefined, null],
    ] as const) {
      const service = await createApp(config, given);
      try {
        const response = await service.app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4318' } });
        expect(response.json()).toMatchObject({ name: 'PasCap', toolchain: expected });
      } finally {
        await service.app.close();
      }
    }
  });
});
