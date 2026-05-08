import { describe, it, expect, vi } from 'vitest';
import { withSchedulerGuard } from '../../src/lambda-scheduler.js';

describe('withSchedulerGuard', () => {
  it('routes to scheduler handler when event.source === aws.scheduler with detail.deadlineNotificationId', async () => {
    const schedulerHandler = vi.fn().mockResolvedValue({ status: 'sent' });
    const inner = vi.fn().mockResolvedValue({ statusCode: 200, body: '' });
    const wrapped = withSchedulerGuard(schedulerHandler)(inner);
    const result = await wrapped(
      {
        source: 'aws.scheduler',
        detail: { deadlineNotificationId: 'dn1', reminderType: 't_minus_30' },
      },
      {},
    );
    expect(schedulerHandler).toHaveBeenCalledWith({
      deadlineNotificationId: 'dn1',
      reminderType: 't_minus_30',
    });
    expect(inner).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'sent' });
  });

  it('falls through to inner when event has no source field (APIGW request)', async () => {
    const schedulerHandler = vi.fn();
    const inner = vi.fn().mockResolvedValue({ statusCode: 200, body: '' });
    const wrapped = withSchedulerGuard(schedulerHandler)(inner);
    await wrapped({ requestContext: { http: { method: 'GET' } } }, {});
    expect(schedulerHandler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it('falls through to inner when source is aws.scheduler but detail is missing (defensive)', async () => {
    const schedulerHandler = vi.fn();
    const inner = vi.fn().mockResolvedValue({ statusCode: 200, body: '' });
    const wrapped = withSchedulerGuard(schedulerHandler)(inner);
    await wrapped({ source: 'aws.scheduler' }, {});
    expect(schedulerHandler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it('falls through to inner when detail lacks deadlineNotificationId (future schedule shape)', async () => {
    const schedulerHandler = vi.fn();
    const inner = vi.fn().mockResolvedValue({ statusCode: 200, body: '' });
    const wrapped = withSchedulerGuard(schedulerHandler)(inner);
    await wrapped({ source: 'aws.scheduler', detail: { foo: 'bar' } }, {});
    expect(schedulerHandler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });
});
