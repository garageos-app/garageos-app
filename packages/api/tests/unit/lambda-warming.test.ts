import { describe, expect, it, vi } from 'vitest';

import { withWarmingGuard } from '../../src/lambda-warming.js';

describe('withWarmingGuard', () => {
  it('returns {ok:true, source:"warming"} and does not delegate when event.source = warming (no warmup)', async () => {
    const inner = vi.fn();
    const guarded = withWarmingGuard(inner);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await guarded({ source: 'warming' }, {}, () => undefined);

    expect(result).toEqual({ ok: true, source: 'warming', warmup: 'skipped' });
    expect(inner).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('invokes the warmup callback when event.source = warming and reports warmup: ok', async () => {
    const inner = vi.fn();
    const warmup = vi.fn().mockResolvedValue(undefined);
    const guarded = withWarmingGuard(inner, warmup);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await guarded({ source: 'warming' }, {}, () => undefined);

    expect(warmup).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, source: 'warming', warmup: 'ok' });

    logSpy.mockRestore();
  });

  it('logs warmup: failed + error but still returns ok when warmup throws', async () => {
    const inner = vi.fn();
    const warmup = vi.fn().mockRejectedValue(new Error('db unreachable'));
    const guarded = withWarmingGuard(inner, warmup);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await guarded({ source: 'warming' }, {}, () => undefined);

    expect(warmup).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, source: 'warming', warmup: 'failed' });
    const logged = logSpy.mock.calls[0]![0] as string;
    expect(logged).toContain('"warmup":"failed"');
    expect(logged).toContain('"error":"db unreachable"');

    logSpy.mockRestore();
  });

  it('delegates to the inner handler for non-warming events (APIGW shape passthrough) and does NOT call warmup', async () => {
    const sentinel = { statusCode: 200, body: '{"ok":true}' };
    const inner = vi.fn().mockResolvedValue(sentinel);
    const warmup = vi.fn();
    const guarded = withWarmingGuard(inner, warmup);

    const apigwEvent = { httpMethod: 'GET', path: '/health', requestContext: { http: {} } };
    const ctx = { fakeContext: true };
    const cb = (): undefined => undefined;

    const result = await guarded(apigwEvent, ctx, cb);

    expect(result).toBe(sentinel);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(apigwEvent, ctx, cb);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('logs warming source on short-circuit (F14.3 visibility)', async () => {
    const inner = vi.fn();
    const guarded = withWarmingGuard(inner);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await guarded({ source: 'warming' }, {}, () => undefined);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = logSpy.mock.calls[0]![0] as string;
    expect(logged).toContain('"source":"warming"');
    expect(logged).toMatch(/"ts":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);

    logSpy.mockRestore();
  });
});
