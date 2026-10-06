import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type ServiceHealth } from '../../src/web/api.js';
import { waitForService } from '../../src/web/connection.js';

const health: ServiceHealth = {
  name: 'PasCap',
  milestone: 'editing-and-export',
  frameRate: '30000/1001',
  workerConcurrency: 1,
};
let fetchMock = vi.fn<typeof fetch>();
function healthResponse(): Response {
  return new Response(JSON.stringify(health), { headers: { 'Content-Type': 'application/json' } });
}
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded local service startup', () => {
  it('returns validated readiness on the first GET and reports the attempt budget', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    fetchMock.mockResolvedValueOnce(healthResponse());
    expect(await waitForService(controller.signal, onAttempt)).toEqual(health);
    expect(onAttempt.mock.calls).toEqual([[1, 5]]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/health', expect.objectContaining({ method: 'GET' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries only serial health GETs across network and server failures with bounded backoff', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce(new Response('<html>Service starting</html>', { status: 503 }))
      .mockResolvedValueOnce(healthResponse());
    const pending = waitForService(controller.signal, onAttempt);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(health);
    expect(onAttempt.mock.calls).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
    ]);
    expect(
      fetchMock.mock.calls.every(
        ([url, options]) => url === '/api/health' && options?.method === 'GET' && options.body === undefined,
      ),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after five failures and preserves the final ApiError details', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    const errors = Array.from({ length: 5 }, (_value, index) => new ApiError(`Service failure ${index + 1}`, 503));
    const probe = vi.spyOn(api, 'health');
    errors.forEach((error) => probe.mockRejectedValueOnce(error));
    const outcome = waitForService(controller.signal, onAttempt).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(errors[4]);
    expect(probe).toHaveBeenCalledTimes(5);
    expect(onAttempt.mock.calls).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds even abort-ignoring hung transports to 32.5 seconds', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const outcome = waitForService(controller.signal, onAttempt).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(32_499);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[4]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ status: 0, kind: 'timeout', message: expect.stringContaining('5 seconds') });
    expect(fetchMock.mock.calls.every(([_url, options]) => options?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([403, 404, 409, 422])('does not retry a non-transient HTTP %i', async (status) => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Resolve this service configuration first.' }), { status }),
    );
    await expect(waitForService(controller.signal, onAttempt)).rejects.toMatchObject({ status, kind: 'http' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'HTML instead of service', response: () => new Response('<html>App shell</html>') },
    {
      name: 'incompatible health schema',
      response: () => new Response(JSON.stringify({ name: 'PasCap', ready: true })),
    },
  ])('does not repeatedly poll $name', async ({ response }) => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(response());
    await expect(waitForService(controller.signal)).rejects.toMatchObject({
      status: 200,
      kind: 'response',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a GET or notify startup after an already-aborted signal', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    controller.abort();
    await expect(waitForService(controller.signal, onAttempt)).rejects.toMatchObject({
      status: 0,
      kind: 'aborted',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight health check without scheduling more attempts', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const outcome = waitForService(controller.signal, onAttempt).catch((error: unknown) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ status: 0, kind: 'aborted', retryable: false });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a retry delay immediately and removes its abort listener', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fetchMock.mockRejectedValueOnce(new TypeError('Offline'));
    const outcome = waitForService(controller.signal, onAttempt).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(await outcome).toMatchObject({ status: 0, kind: 'aborted' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors cancellation triggered by the attempt callback without sending a request', async () => {
    const controller = new AbortController();
    await expect(waitForService(controller.signal, () => controller.abort())).rejects.toMatchObject({
      status: 0,
      kind: 'aborted',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not classify an unexpected callback/probe error as a transient service failure', async () => {
    const controller = new AbortController();
    const unexpected = new Error('Unexpected probe error');
    vi.spyOn(api, 'health').mockRejectedValueOnce(unexpected);
    await expect(waitForService(controller.signal)).rejects.toBe(unexpected);
    expect(vi.getTimerCount()).toBe(0);
  });
});
