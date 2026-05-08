import { describe, expect, it, vi } from 'vitest';

import { withWarmingGuard } from '../../src/lambda-warming.js';

describe('withWarmingGuard', () => {
  it('returns {ok:true, source:"warming"} and does not delegate when event.source = warming', async () => {
    const inner = vi.fn();
    const guarded = withWarmingGuard(inner);

    const result = await guarded({ source: 'warming' }, {}, () => undefined);

    expect(result).toEqual({ ok: true, source: 'warming' });
    expect(inner).not.toHaveBeenCalled();
  });

  it('delegates to the inner handler for non-warming events (APIGW shape passthrough)', async () => {
    const sentinel = { statusCode: 200, body: '{"ok":true}' };
    const inner = vi.fn().mockResolvedValue(sentinel);
    const guarded = withWarmingGuard(inner);

    const apigwEvent = { httpMethod: 'GET', path: '/health', requestContext: { http: {} } };
    const ctx = { fakeContext: true };
    const cb = (): undefined => undefined;

    const result = await guarded(apigwEvent, ctx, cb);

    expect(result).toBe(sentinel);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(apigwEvent, ctx, cb);
  });
});
