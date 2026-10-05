import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatNotices, runtimeLicenses } from '../../scripts/licenses.js';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { forEachSerial } from '../../src/shared/serial.js';

interface PackageFixture { name: string; version: string; license: string; packagePath: string; dev?: boolean; files: Record<string, string> }
const roots: string[] = [];
const header = { host: '127.0.0.1:4318' };
const mit = 'MIT License\r\nCopyright (c) Example contributor\r\nPermission and exact disclaimer.\r\n';
const dependency = (overrides: Partial<PackageFixture> = {}): PackageFixture => ({ name: 'example', version: '1.0.0', license: 'MIT', packagePath: 'node_modules/example', files: { LICENSE: mit }, ...overrides });

async function fixture(packages: readonly PackageFixture[] = [dependency()]): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-license-unit-')); roots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pascap', version: '0.1.0', license: 'MIT' }));
    const entries: Record<string, unknown> = { '': { name: 'pascap', version: '0.1.0', license: 'MIT' } };
    await forEachSerial(packages, async (item) => {
        entries[item.packagePath] = { version: item.version, license: item.license, ...(item.dev === undefined ? {} : { dev: item.dev }) };
        const directory = path.join(root, item.packagePath);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: item.name, version: item.version, license: item.license }));
        await forEachSerial(Object.entries(item.files), async ([filename, text]) => {
            await mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
            await writeFile(path.join(directory, filename), text);
        });
    });
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: entries }));
    return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('locked production licenses and exact notices', () => {
    it('retains nested versions and every shipped notice verbatim, excluding development-only installs', async () => {
        const packages = [
            dependency({ name: 'fast-uri', version: '4.2.1', license: 'BSD-3-Clause', packagePath: 'node_modules/fast-uri', files: { LICENSE: 'BSD copyright\n', NOTICE: 'Separate attribution\n', 'src/LICENSE.md': 'Nested component notice\n' } }),
            dependency({ name: 'ajv', packagePath: 'node_modules/ajv' }),
            dependency({ name: 'fast-uri', version: '3.1.8', license: 'BSD-3-Clause', packagePath: 'node_modules/ajv/node_modules/fast-uri', files: { LICENSE: 'Earlier BSD notice\n' } }),
            dependency({ name: 'developer', license: 'GPL-3.0-only', packagePath: 'node_modules/developer', dev: true, files: {} }),
        ];
        const root = await fixture(packages);
        const inventory = await runtimeLicenses(root);
        expect(inventory.map((item) => `${item.name}@${item.version}`)).toEqual(['ajv@1.0.0', 'fast-uri@3.1.8', 'fast-uri@4.2.1']);
        expect(inventory[0]!.notices).toEqual([{ filename: 'LICENSE', text: mit }]);
        expect(inventory[2]!.notices).toEqual([
            { filename: 'LICENSE', text: 'BSD copyright\n' }, { filename: 'NOTICE', text: 'Separate attribution\n' },
            { filename: 'src/LICENSE.md', text: 'Nested component notice\n' },
        ]);
        expect(await readFile(path.join(root, 'node_modules/ajv/LICENSE'), 'utf8')).toBe(mit);
    });

    it('is deterministic and read-only, even with excluded development packages uninstalled', async () => {
        const root = await fixture([dependency(), dependency({ name: 'build-tool', dev: true, packagePath: 'node_modules/build-tool' })]);
        await rm(path.join(root, 'node_modules/build-tool'), { recursive: true });
        const before = await readFile(path.join(root, 'package-lock.json'), 'utf8');
        const inventory = await runtimeLicenses(root);
        expect(await runtimeLicenses(root)).toEqual(inventory);
        expect(await readFile(path.join(root, 'package-lock.json'), 'utf8')).toBe(before);
        expect(await readdir(root)).toEqual(['node_modules', 'package-lock.json', 'package.json']);
    });

    it('includes reviewed emitted Vite/Rolldown helpers and their third-party notices, not every build tool', async () => {
        const root = await fixture([
            dependency(),
            dependency({ name: 'vite', packagePath: 'node_modules/vite', dev: true, files: { 'LICENSE.md': 'Vite copyright and MIT terms\n' } }),
            dependency({ name: 'rolldown', packagePath: 'node_modules/rolldown', dev: true, files: { LICENSE: 'Rolldown MIT\n', 'THIRD-PARTY-LICENSE': 'Rollup and esbuild attribution\n' } }),
            dependency({ name: 'test-runner', packagePath: 'node_modules/test-runner', dev: true, files: {} }),
        ]);
        const inventory = await runtimeLicenses(root);
        expect(inventory.map((item) => [item.name, item.scope])).toEqual([
            ['example', 'production'], ['rolldown', 'emitted-helper'], ['vite', 'emitted-helper'],
        ]);
        expect(inventory[1]!.notices.map((notice) => notice.filename)).toEqual(['LICENSE', 'THIRD-PARTY-LICENSE']);
        expect(formatNotices('PasCap MIT\n', inventory)).toContain('Rollup and esbuild attribution\n');
    });

    it.each(['name', 'version', 'license'] as const)('rejects an installed %s differing from the lockfile', async (property) => {
        const root = await fixture();
        await writeFile(path.join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.0.0', license: 'MIT', [property]: property === 'license' ? 'ISC' : 'different' }));
        await expect(runtimeLicenses(root)).rejects.toThrow('differs from the lockfile');
    });

    it('requires review of a new production license instead of silently accepting it', async () => {
        const root = await fixture([dependency({ license: 'GPL-3.0-only' })]);
        await expect(runtimeLicenses(root)).rejects.toThrow('Review the new production license');
    });

    it.each([{}, { LICENSE: '' }])('fails when a runtime notice is absent or empty: %j', async (files) => {
        const root = await fixture([dependency({ files })]);
        await expect(runtimeLicenses(root)).rejects.toThrow(/No shipped license|empty/);
    });

    it('fails on an absent installed runtime package instead of claiming a complete inventory', async () => {
        const root = await fixture(); await rm(path.join(root, 'node_modules/example'), { recursive: true });
        await expect(runtimeLicenses(root)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects symlinked notices without reading or changing their targets', async () => {
        const root = await fixture([dependency({ files: {} })]);
        const target = path.join(root, 'unrelated.txt'); await writeFile(target, 'Unrelated bytes');
        await symlink(target, path.join(root, 'node_modules/example/LICENSE'));
        await expect(runtimeLicenses(root)).rejects.toThrow('symlinks');
        expect(await readFile(target, 'utf8')).toBe('Unrelated bytes');
    });

    it('rejects symlinked package ancestors', async () => {
        const root = await fixture(); await rm(path.join(root, 'node_modules/example'), { recursive: true });
        await symlink(root, path.join(root, 'node_modules/example'));
        await expect(runtimeLicenses(root)).rejects.toThrow('symlinks');
    });

    it('rejects traversal in a lockfile package path before reading outside the fixture', async () => {
        const root = await fixture();
        await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { version: '0.1.0', license: 'MIT' }, 'node_modules/../../outside': { version: '1.0.0', license: 'MIT' } } }));
        await expect(runtimeLicenses(root)).rejects.toThrow('Invalid locked package path');
    });

    it('requires matching approved project metadata', async () => {
        const root = await fixture(); await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pascap', version: '0.1.0', license: 'UNLICENSED' }));
        await expect(runtimeLicenses(root)).rejects.toThrow('approved MIT');
    });

    it('uses only the explicitly reviewed version and upstream reference for the missing packaged license', async () => {
        const root = await fixture([dependency({ name: 'abstract-logging', version: '2.0.1', packagePath: 'node_modules/abstract-logging', files: { 'Readme.md': '[MIT License](http://jsumners.mit-license.org/)' } })]);
        await mkdir(path.join(root, 'docs/licenses'), { recursive: true });
        const supplement = 'MIT linked upstream terms · exact reviewed notice\n';
        await writeFile(path.join(root, 'docs/licenses/abstract-logging-2.0.1.txt'), supplement);
        expect((await runtimeLicenses(root))[0]!.notices).toEqual([{ filename: 'docs/licenses/abstract-logging-2.0.1.txt', text: supplement }]);
        await writeFile(path.join(root, 'node_modules/abstract-logging/Readme.md'), 'Another website');
        await expect(runtimeLicenses(root)).rejects.toThrow('license reference changed');
    });

    it('does not inject a notice into another version of the linked-license package', async () => {
        const root = await fixture([dependency({ name: 'abstract-logging', version: '2.0.2', packagePath: 'node_modules/abstract-logging', files: { 'Readme.md': '[MIT License](http://jsumners.mit-license.org/)' } })]);
        await expect(runtimeLicenses(root)).rejects.toThrow('No shipped license');
    });

    it('keeps exact copyright/notice bytes in deterministic output without private absolute paths', async () => {
        const root = await fixture(); const inventory = await runtimeLicenses(root);
        const output = formatNotices('Approved PasCap MIT text\n', inventory);
        expect(formatNotices('Approved PasCap MIT text\n', inventory)).toBe(output);
        expect(output).toContain('example@1.0.0 · MIT'); expect(output).toContain(mit);
        expect(output).toContain('Approved PasCap MIT text\n'); expect(output).not.toContain(root);
    });

    it('serves the built notice artifact without media work and preserves loopback guards', async () => {
        const root = await fixture(); const text = formatNotices('PasCap MIT\n', await runtimeLicenses(root));
        const webDir = path.join(root, 'web'); await mkdir(webDir);
        await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>Disposable licensing fixture</title>');
        await writeFile(path.join(webDir, 'THIRD_PARTY_NOTICES.txt'), text);
        const { app, jobs } = await createApp(createConfig({ dataDir: path.join(root, 'cache'), webDir, mediaRoots: [], port: 4318 }));
        try {
            const response = await app.inject({ url: '/THIRD_PARTY_NOTICES.txt', headers: header });
            expect(response.statusCode).toBe(200); expect(response.body).toBe(text);
            expect(jobs.list()).toEqual([]);
            expect((await app.inject({ url: '/THIRD_PARTY_NOTICES.txt', headers: { host: 'untrusted.example' } })).statusCode).toBe(403);
        } finally { await app.close(); }
    });
});