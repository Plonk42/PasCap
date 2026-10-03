import { describe, expect, it } from 'vitest';
import { forEachSerial, whileSerial } from '../../src/shared/serial.js';

function gate() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('bounded serial operations', () => {
  it('keeps exactly one asynchronous operation in flight and preserves input order', async () => {
    const first = gate(); const second = gate();
    const started: number[] = []; const finished: number[] = [];
    let active = 0; let peak = 0;
    const pending = forEachSerial([10, 20], async (item, index) => {
      started.push(item); peak = Math.max(peak, ++active);
      await (index === 0 ? first.promise : second.promise);
      finished.push(item); active--;
    });
    expect(started).toEqual([10]); expect(finished).toEqual([]);
    first.release();
    await first.promise; await Promise.resolve();
    expect(started).toEqual([10, 20]); expect(finished).toEqual([10]);
    second.release(); await pending;
    expect(finished).toEqual([10, 20]); expect(peak).toBe(1); expect(active).toBe(0);
  });

  it('does not request future generator items before the active operation completes', async () => {
    const first = gate(); const requested: number[] = [];
    function* items() { for (const item of [1, 2, 3]) { requested.push(item); yield item; } }
    const pending = forEachSerial(items(), (item) => item === 1 ? first.promise : undefined);
    expect(requested).toEqual([1]); first.release(); await pending;
    expect(requested).toEqual([1, 2, 3]);
  });

  it('stops at a rejected operation and closes its iterator', async () => {
    const failure = new Error('Stop serial work'); let closed = false;
    const started: number[] = [];
    function* items() { try { yield 1; yield 2; yield 3; } finally { closed = true; } }
    await expect(forEachSerial(items(), (item) => { started.push(item); return item === 2 ? Promise.reject(failure) : undefined; })).rejects.toBe(failure);
    expect(started).toEqual([1, 2]); expect(closed).toBe(true);
  });

  it('rejects synchronous operation errors without starting later work', async () => {
    const failure = new Error('Synchronous failure'); const started: number[] = [];
    await expect(forEachSerial([1, 2], (item) => { started.push(item); throw failure; })).rejects.toBe(failure);
    expect(started).toEqual([1]);
  });

  it('preserves the primary error when iterator cleanup also throws', async () => {
    const failure = new Error('Operation failure');
    const items: Iterable<number> = { [Symbol.iterator]: () => ({ next: () => ({ done: false, value: 1 }), return: () => { throw new Error('Cleanup failure'); } }) };
    await expect(forEachSerial(items, () => { throw failure; })).rejects.toBe(failure);
  });

  it('rejects iterator errors', async () => {
    const failure = new Error('Iteration failure');
    function* items(): Generator<number> { throw failure; }
    await expect(forEachSerial(items(), () => undefined)).rejects.toBe(failure);
  });

  it('accepts empty input and long immediate-operation inputs without synchronous recursion', async () => {
    let visited = 0;
    await forEachSerial([], () => { throw new Error('An empty input must not invoke an operation'); });
    await forEachSerial(Array.from({ length: 20_000 }, (_, index) => index), (item, index) => {
      expect(item).toBe(index); visited++;
    });
    expect(visited).toBe(20_000);
  });

  it('rechecks changing state after completion and sees work added during an active operation', async () => {
    const first = gate(); const items = [1]; const visited: number[] = [];
    const pending = whileSerial(() => items.length > 0, async () => {
      const item = items.shift()!; visited.push(item);
      if (item === 1) await first.promise;
    });
    items.push(2, 3); expect(visited).toEqual([1]); first.release(); await pending;
    expect(visited).toEqual([1, 2, 3]);
  });

  it('propagates predicate errors and never executes after a false predicate', async () => {
    const failure = new Error('Predicate failure'); let started = 0;
    await whileSerial(() => false, () => { started++; });
    await expect(whileSerial(() => { throw failure; }, () => { started++; })).rejects.toBe(failure);
    expect(started).toBe(0);
  });
});