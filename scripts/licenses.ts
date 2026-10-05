import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { forEachSerial } from '../src/shared/serial.js';

const reviewedLicenses = new Set(['MIT', 'ISC', 'BSD-3-Clause', 'BlueOak-1.0.0']);
// The current build emits Vite preload and Rolldown module-interop helpers.
// Retain their upstream notices, not the whole development dependency tree.
const emittedHelpers = new Set(['node_modules/vite', 'node_modules/rolldown']);
const packageSchema = z.looseObject({ name: z.string().min(1), version: z.string().min(1), license: z.string().min(1) });
const lockSchema = z.looseObject({
    lockfileVersion: z.literal(3),
    packages: z.record(z.string(), z.looseObject({ version: z.string().min(1), license: z.string().min(1), dev: z.boolean().optional() })),
});
const NOTICE_NAME = /^(?:third[-_. ]party[-_. ])?(?:licen[sc]e|copying|notice)(?:[.-]|$)/i;

export interface LicenseNotice { filename: string; text: string }
export interface RuntimeLicense { name: string; version: string; license: string; packagePath: string; scope: 'production' | 'emitted-helper'; notices: LicenseNotice[] }

async function regularText(filename: string): Promise<string> {
    if (!(await lstat(filename)).isFile()) throw new Error('License inputs must be regular files, not symlinks.');
    const text = await readFile(filename, 'utf8');
    if (!text.trim()) throw new Error('A license/notice file is empty.');
    return text;
}

/** Include nested notices, but separately inventoried nested dependencies are not this package. */
async function packageNotices(directory: string, relative = ''): Promise<LicenseNotice[]> {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Installed package directories must not be symlinks.');
    const entries = await readdir(directory, { withFileTypes: true });
    const notices: LicenseNotice[] = [];
    await forEachSerial(entries.sort((a, b) => a.name.localeCompare(b.name, 'en')), async (entry) => {
        if (entry.name === 'node_modules') return;
        if (entry.isSymbolicLink()) throw new Error('Shipped license inputs must not traverse symlinks.');
        const filename = path.join(directory, entry.name);
        const local = relative + entry.name;
        if (entry.isDirectory()) notices.push(...await packageNotices(filename, `${local}/`));
        else if (NOTICE_NAME.test(entry.name)) notices.push({ filename: local, text: await regularText(filename) });
    });
    return notices;
}

/** Locked production installations plus reviewed emitted helpers; no network or media reads. */
export async function runtimeLicenses(root: string): Promise<RuntimeLicense[]> {
    const manifest = packageSchema.parse(JSON.parse(await regularText(path.join(root, 'package.json'))));
    const lock = lockSchema.parse(JSON.parse(await regularText(path.join(root, 'package-lock.json'))));
    const project = lock.packages[''];
    if (manifest.license !== 'MIT' || project?.license !== 'MIT' || manifest.version !== project.version) throw new Error('Project and lockfile must agree on the approved MIT license and version.');
    const inventory: RuntimeLicense[] = [];
    await forEachSerial(Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en')), async ([packagePath, locked]) => {
        if (!packagePath || (locked.dev === true && !emittedHelpers.has(packagePath))) return;
        const components = packagePath.split('/');
        if (components[0] !== 'node_modules' || components.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid locked package path.');
        let directory = root;
        await forEachSerial(components, async (part) => {
            directory = path.join(directory, part);
            if (!(await lstat(directory)).isDirectory()) throw new Error('Installed package paths must use regular directories, not symlinks.');
        });
        const installed = packageSchema.parse(JSON.parse(await regularText(path.join(directory, 'package.json'))));
        const expectedName = packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (installed.name !== expectedName || installed.version !== locked.version || installed.license !== locked.license) throw new Error(`Installed package differs from the lockfile: ${packagePath}`);
        if (!reviewedLicenses.has(installed.license)) throw new Error(`Review the new production license before distribution: ${installed.name} (${installed.license}).`);
        const notices = await packageNotices(directory);
        if (!notices.length && installed.name === 'abstract-logging' && installed.version === '2.0.1') {
            // This exact published package links its license instead of shipping it.
            // Keep the linked upstream copyright/text; never invent a generic MIT notice.
            const readme = await regularText(path.join(directory, 'Readme.md'));
            if (!readme.includes('[MIT License](http://jsumners.mit-license.org/)')) throw new Error('The reviewed abstract-logging license reference changed.');
            const filename = 'docs/licenses/abstract-logging-2.0.1.txt';
            notices.push({ filename, text: await regularText(path.join(root, filename)) });
        }
        if (!notices.length) throw new Error(`No shipped license/notice found for ${installed.name}@${installed.version}; review its upstream terms explicitly.`);
        inventory.push({ name: installed.name, version: installed.version, license: installed.license, packagePath, scope: emittedHelpers.has(packagePath) ? 'emitted-helper' : 'production', notices });
    });
    if (!inventory.length) throw new Error('The production dependency inventory is empty.');
    return inventory;
}

export function formatNotices(projectLicense: string, inventory: readonly RuntimeLicense[]): string {
    return [
        'PasCap · project and third-party notices',
        'Production npm packages and reviewed emitted build helpers from the lockfile.',
        'Not all listed packages are embedded in the browser. Full upstream notices are retained.',
        'Native FFmpeg/libx264, Node.js/OS packages and other test/build tools have separate terms.',
        'See the distribution contract: https://github.com/Plonk42/PasCap/blob/main/docs/LICENSING.md',
        '\nPasCap · MIT\n', projectLicense,
        ...inventory.flatMap((item) => [
            `\n${'='.repeat(72)}\n${item.name}@${item.version} · ${item.license}\nScope: ${item.scope}\nInstalled dependency: ${item.packagePath}\n`,
            ...item.notices.map((notice) => `--- ${notice.filename} ---\n${notice.text}`),
        ]),
        '',
    ].join('\n');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--build'].includes(args[0]!)) throw new Error('Use --check for read-only inventory or --build for the built UI notice artifact.');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const inventory = await runtimeLicenses(root);
    const projectLicense = await regularText(path.join(root, 'LICENSE'));
    if (args[0] === '--build') {
        const directory = path.join(root, 'dist', 'web');
        if (!(await lstat(directory)).isDirectory()) throw new Error('Build the UI before its notice artifact.');
        await writeFile(path.join(directory, 'THIRD_PARTY_NOTICES.txt'), formatNotices(projectLicense, inventory), { flag: 'wx', mode: 0o644 });
    }
    const families = [...new Set(inventory.map((item) => item.license))].sort((a, b) => a.localeCompare(b, 'en'));
    const production = inventory.filter((item) => item.scope === 'production').length;
    console.log(`Verified ${production} production installations and ${inventory.length - production} emitted-helper packages with their notices (${families.join(', ')}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(); }
    catch (error) { console.error(error instanceof Error ? error.message : 'License inventory failed.'); process.exitCode = 1; }
}