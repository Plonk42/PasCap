import { stripVTControlCharacters } from 'node:util';

export interface FailureSignature {
  /** File and title without line numbers, so one test groups across commits. */
  test: string;
  kind: 'timeout' | 'failure';
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const PLAYWRIGHT = /^\s*\d+\) (?:\[[^\]]+\] › )?(tests\/[^:\s]+):\d+:\d+ › (.+)$/;
const VITEST = /^\s*FAIL\s+(tests\/\S+) > (.+)$/;
const TIMEOUT = /Test timeout of \d+ms exceeded|Test timed out in \d+ms/;
const PREREQUISITE = /^Error: (Firefox \w+ prerequisite failed)\./;
/** Lines between a failure header and its error in Playwright/Vitest output. */
const ERROR_WINDOW = 12;

/** Playwright pads failure headers with a ─ rule. */
function testTitle(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '─' || text[end - 1] === ' ')) end--;
  return text.slice(0, end);
}

/** Failing tests in one GitHub Actions job log (Playwright list/dot or Vitest output). */
export function failureSignatures(log: string): FailureSignature[] {
  const lines = log.split('\n').map((line) => stripVTControlCharacters(line).replace(TIMESTAMP, ''));
  const headers = lines.flatMap((line, index) => {
    const match = PLAYWRIGHT.exec(line) ?? VITEST.exec(line);
    return match ? [{ index, test: `${match[1]} › ${testTitle(match[2]!.trim())}` }] : [];
  });
  const found = new Map<string, FailureSignature>();
  headers.forEach(({ index, test }, position) => {
    // The error belongs to this header only until the next failure header.
    const end = Math.min(index + 1 + ERROR_WINDOW, headers[position + 1]?.index ?? lines.length);
    const timedOut = lines.slice(index + 1, end).some((next) => TIMEOUT.test(next));
    if (timedOut || !found.has(test)) found.set(test, { test, kind: timedOut ? 'timeout' : 'failure' });
  });
  for (const line of lines) {
    const prerequisite = PREREQUISITE.exec(line)?.[1];
    if (prerequisite) found.set(prerequisite, { test: prerequisite, kind: 'failure' });
  }
  return [...found.values()];
}
