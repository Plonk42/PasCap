import { forEachSerial } from '../../src/shared/serial.js';
import { failureSignatures, type FailureSignature } from './failure-signatures.js';

/** Group failing tests across recent failed CI runs, so a repeated signature is seen as one problem. */
interface Run {
  id: number;
  head_branch: string;
  created_at: string;
}
interface Job {
  id: number;
  name: string;
  conclusion: string | null;
}

const count = Number(process.argv[2] ?? 30);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Usage: npm run ci:failures -- [runs 1-100]');
const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
if (!token) throw new Error('Set GH_TOKEN, for example: GH_TOKEN="$(gh auth token)" npm run ci:failures');
const repository = process.env['GITHUB_REPOSITORY'] ?? 'Plonk42/PasCap';

async function github(path: string): Promise<Response> {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response;
}

const runs = (
  (await (await github(`actions/workflows/ci.yml/runs?status=failure&per_page=${count}`)).json()) as {
    workflow_runs: Run[];
  }
).workflow_runs;
const grouped = new Map<string, { signature: FailureSignature; runs: string[] }>();
const unrecognised: string[] = [];
await forEachSerial(runs, async (run) => {
  const label = `${run.head_branch} ${run.created_at.slice(0, 16)} #${run.id}`;
  const { jobs } = (await (await github(`actions/runs/${run.id}/jobs?per_page=100`)).json()) as { jobs: Job[] };
  const failed = jobs.filter((job) => job.conclusion === 'failure' && job.name !== 'Delivery gate');
  await forEachSerial(failed, async (job) => {
    const signatures = await github(`actions/jobs/${job.id}/logs`).then(
      async (response) => failureSignatures(await response.text()),
      () => null,
    );
    if (!signatures?.length) unrecognised.push(`${job.name}${signatures ? '' : ' (logs unavailable)'} · ${label}`);
    for (const signature of signatures ?? []) {
      const key = `${signature.kind} ${signature.test}`;
      const entry = grouped.get(key) ?? { signature, runs: [] };
      entry.runs.push(label);
      grouped.set(key, entry);
    }
  });
});

console.log(`${runs.length} failed CI runs in ${repository}, newest first.\n`);
for (const { signature, runs: seen } of [...grouped.values()].sort(
  (left, right) => right.runs.length - left.runs.length,
)) {
  console.log(`${seen.length}× ${signature.kind}: ${signature.test}`);
  for (const run of seen) console.log(`     ${run}`);
}
if (unrecognised.length) {
  console.log('\nFailed jobs without a recognised test failure (setup, infrastructure or expired logs):');
  for (const job of unrecognised) console.log(`     ${job}`);
}
