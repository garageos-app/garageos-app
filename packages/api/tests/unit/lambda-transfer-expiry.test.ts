import { describe, expect, it, vi } from 'vitest';

import { withTransferExpiryGuard } from '../../src/lambda-transfer-expiry.js';

describe('withTransferExpiryGuard', () => {
  it('routes {source:"transfer-expiry"} to the handler and not to inner', async () => {
    const handler = vi.fn().mockResolvedValue({ sweptCount: 5 });
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withTransferExpiryGuard(inner, handler);

    const result = await wrapped({ source: 'transfer-expiry' }, {}, undefined);

    expect(result).toEqual({ sweptCount: 5 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes APIGW requests through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withTransferExpiryGuard(inner, handler);

    const event = { requestContext: { http: { method: 'GET' } }, rawPath: '/health' };
    await wrapped(event, {}, undefined);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes warming and deadline-scheduler events through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue('inner');
    const wrapped = withTransferExpiryGuard(inner, handler);

    await wrapped({ source: 'warming' }, {}, undefined);
    await wrapped(
      {
        source: 'aws.scheduler',
        detail: { deadlineNotificationId: 'd', reminderType: 't_minus_30' },
      },
      {},
      undefined,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
