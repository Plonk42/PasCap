import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/api.js';
import { callOperation } from '../../src/web/operations.js';

let fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callOperation', () => {
  it('posts the input to the operation route and returns its validated output', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ revision: 3, duration: { frames: 60, timecode: '00:02:00' } }), { status: 200 }),
    );
    const result = await callOperation('edit', {
      projectId: 'flight',
      expectedRevision: 2,
      commands: [{ type: 'bookmark-add', frame: 30 }],
    });
    expect(result).toEqual({ revision: 3, duration: { frames: 60, timecode: '00:02:00' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ops/edit');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      projectId: 'flight',
      expectedRevision: 2,
      commands: [{ type: 'bookmark-add', frame: 30 }],
    });
  });

  it('rejects a response that does not match the operation output', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ revision: 'three' }), { status: 200 }));
    await expect(
      callOperation('edit', {
        projectId: 'flight',
        expectedRevision: 2,
        commands: [{ type: 'bookmark-add', frame: 1 }],
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
