import { describe, expect, it, vi } from 'vitest';

import { withPersonalDeadlineSweepGuard } from '../../src/lambda-personal-deadline-sweep.js';

describe('withPersonalDeadlineSweepGuard', () => {
  it('routes {source:"personal-deadline-sweep"} to the handler and not to inner', async () => {
    const handler = vi.fn().mockResolvedValue({
      overdueFlipped: 2,
      staleCancelled: 1,
      channelsOffCancelled: 0,
      sent: 3,
      failed: 0,
    });
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withPersonalDeadlineSweepGuard(inner, handler);

    const result = await wrapped({ source: 'personal-deadline-sweep' }, {}, undefined);

    expect(result).toEqual({
      overdueFlipped: 2,
      staleCancelled: 1,
      channelsOffCancelled: 0,
      sent: 3,
      failed: 0,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes APIGW requests through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withPersonalDeadlineSweepGuard(inner, handler);

    const event = { requestContext: { http: { method: 'GET' } }, rawPath: '/health' };
    await wrapped(event, {}, undefined);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes {source:"warming"} through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue('inner');
    const wrapped = withPersonalDeadlineSweepGuard(inner, handler);

    await wrapped({ source: 'warming' }, {}, undefined);

    expect(handler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('passes {source:"transfer-expiry"} through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue('inner');
    const wrapped = withPersonalDeadlineSweepGuard(inner, handler);

    await wrapped({ source: 'transfer-expiry' }, {}, undefined);

    expect(handler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
