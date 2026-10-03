export type SerialOperation<T> = (item: T, index: number) => void | PromiseLike<unknown>;

/** One operation in flight, without building a promise chain for the whole input.
 * The next item is requested only after the previous operation settles.
 */
export function forEachSerial<T>(items: Iterable<T>, operation: SerialOperation<T>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const iterator = items[Symbol.iterator]();
    let index = 0;
    const fail = (error: unknown): void => {
      try { iterator.return?.(); }
      catch { /* Preserve the operation/iteration error if iterator cleanup also fails. */ }
      reject(error);
    };
    const advance = (): void => {
      try {
        const item = iterator.next();
        if (item.done) { resolve(); return; }
        Promise.resolve(operation(item.value, index++)).then(advance, fail);
      } catch (error) { fail(error); }
    };
    advance();
  });
}

/** Recheck mutable state after each settled operation; auxiliary memory stays bounded. */
export function whileSerial(shouldContinue: () => boolean, operation: () => void | PromiseLike<unknown>): Promise<void> {
  function* pending(): Generator<undefined> {
    while (shouldContinue()) yield undefined;
  }
  return forEachSerial(pending(), operation);
}