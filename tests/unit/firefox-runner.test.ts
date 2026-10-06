import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Call {
  command: string;
  args: string[];
  runtime: string;
  server: string;
  cookie: string;
}

// Shell ownership/status regressions only. The actual browser/backend has separate
// positive/negative synthetic checks; these shims are not playback qualification.
describe('private Firefox audio runner lifecycle', () => {
  it.each([
    { failure: '', status: 0, kill: true, browser: true },
    { failure: 'browser', status: 27, kill: true, browser: true },
    { failure: 'startup', status: 31, kill: false, browser: false },
    { failure: 'query', status: 32, kill: true, browser: false },
    { failure: 'sink', status: 1, kill: true, browser: false },
    { failure: 'TERM', status: 143, kill: true, browser: true },
    { failure: 'INT', status: 130, kill: true, browser: true },
  ])('cleans only its private server/scratch on $failure (exit $status)', ({ failure, status, kill, browser }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pascap-runner-test-'));
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'calls');
    mkdirSync(bin);
    const shim = `#!${process.execPath}
            const fs = require('node:fs'), path = require('node:path');
            const command = path.basename(process.argv[1]), args = process.argv.slice(2);
            const env = process.env, failure = env.PASCAP_TEST_FAILURE;
            fs.appendFileSync(env.PASCAP_TEST_LOG, JSON.stringify({ command, args, runtime: env.PULSE_RUNTIME_PATH, server: env.PULSE_SERVER, cookie: env.PULSE_COOKIE }) + '\\n');
            if (command === 'pulseaudio') {
                if (args.includes('--kill')) process.exit(0);
                if (failure === 'startup') process.exit(31);
                fs.writeFileSync(path.join(env.PULSE_RUNTIME_PATH, 'pid'), 'owned test server');
            } else if (command === 'pactl') {
                if (failure === 'query') process.exit(32);
                if (args[0] === 'get-default-sink') console.log(failure === 'sink' ? 'unexpected' : 'pascap_ci');
            } else {
                if (failure === 'TERM' || failure === 'INT') process.kill(process.ppid, 'SIG' + failure);
                process.exit(failure === 'browser' ? 27 : 0);
            }
        `;
    for (const command of ['pulseaudio', 'pactl', 'xvfb-run'])
      writeFileSync(path.join(bin, command), shim, { mode: 0o700 });
    try {
      const result = spawnSync('bash', [path.resolve('scripts/ci/firefox.sh'), 'unused-test-command'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PASCAP_TEST_LOG: log, PASCAP_TEST_FAILURE: failure },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Call);
      const start = calls[0]!;
      const audioDir = path.dirname(start.runtime);
      expect(audioDir).toMatch(/^\/tmp\/pascap-firefox-audio\.[a-zA-Z0-9]+$/);
      expect(start.server).toBe(`unix:${audioDir}/native`);
      expect(start.cookie).toBe(`${audioDir}/cookie`);
      expect(start.args).toContain('--load=module-null-sink sink_name=pascap_ci rate=48000 channels=2');
      expect(start.args).toContain(
        `--load=module-native-protocol-unix socket=${audioDir}/native auth-cookie=${audioDir}/cookie`,
      );
      expect(
        calls.every(
          (call) => call.runtime === start.runtime && call.server === start.server && call.cookie === start.cookie,
        ),
      ).toBe(true);
      expect(calls.some((call) => call.command === 'xvfb-run')).toBe(browser);
      expect(calls.filter((call) => call.command === 'pulseaudio' && call.args.includes('--kill'))).toHaveLength(
        kill ? 1 : 0,
      );
      expect(existsSync(audioDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
