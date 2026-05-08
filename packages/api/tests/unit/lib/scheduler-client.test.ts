import { mockClient } from 'aws-sdk-client-mock';
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';

import { _resetSchedulerClientForTests } from '../../../src/lib/scheduler-client.js';

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.AWS_REGION ??= 'eu-central-1';
  process.env.SCHEDULER_GROUP_NAME = 'garageos-deadlines';
  process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/test-scheduler';
  process.env.LAMBDA_FUNCTION_ARN =
    'arn:aws:lambda:eu-central-1:123456789012:function:garageos-api';
});

const schedulerMock = mockClient(SchedulerClient);

beforeEach(() => {
  schedulerMock.reset();
  _resetSchedulerClientForTests();
});

describe('createReminderSchedule', () => {
  it('issues CreateSchedule with correct shape', async () => {
    schedulerMock.on(CreateScheduleCommand).resolves({
      ScheduleArn: 'arn:aws:scheduler:eu-central-1:123:schedule/garageos-deadlines/deadline-abc',
    });
    const { createReminderSchedule } = await import('../../../src/lib/scheduler-client.js');
    const arn = await createReminderSchedule({
      scheduleName: 'deadline-00000000-0000-0000-0000-000000000001',
      scheduledFor: new Date('2026-12-01T07:00:00Z'),
      payload: {
        deadlineNotificationId: '00000000-0000-0000-0000-000000000001',
        reminderType: 't_minus_30',
      },
    });
    expect(arn).toMatch(/^arn:aws:scheduler:/);
    const call = schedulerMock.commandCalls(CreateScheduleCommand)[0]!;
    expect(call.args[0].input).toMatchObject({
      Name: 'deadline-00000000-0000-0000-0000-000000000001',
      GroupName: 'garageos-deadlines',
      ScheduleExpression: 'at(2026-12-01T07:00:00)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: 'arn:aws:lambda:eu-central-1:123456789012:function:garageos-api',
        RoleArn: 'arn:aws:iam::123456789012:role/test-scheduler',
        Input: JSON.stringify({
          source: 'aws.scheduler',
          detail: {
            deadlineNotificationId: '00000000-0000-0000-0000-000000000001',
            reminderType: 't_minus_30',
          },
        }),
        RetryPolicy: { MaximumRetryAttempts: 3 },
      },
    });
  });
});

describe('deleteReminderSchedule', () => {
  it('issues DeleteSchedule', async () => {
    schedulerMock.on(DeleteScheduleCommand).resolves({});
    const { deleteReminderSchedule } = await import('../../../src/lib/scheduler-client.js');
    await deleteReminderSchedule('deadline-abc');
    const call = schedulerMock.commandCalls(DeleteScheduleCommand)[0]!;
    expect(call.args[0].input).toEqual({
      Name: 'deadline-abc',
      GroupName: 'garageos-deadlines',
    });
  });

  it('swallows ResourceNotFoundException (idempotent)', async () => {
    schedulerMock.on(DeleteScheduleCommand).rejects(
      new ResourceNotFoundException({
        message: 'not found',
        Message: 'not found',
        $metadata: {},
      }),
    );
    const { deleteReminderSchedule } = await import('../../../src/lib/scheduler-client.js');
    await expect(deleteReminderSchedule('deadline-missing')).resolves.toBeUndefined();
  });

  it('rethrows non-ResourceNotFound errors', async () => {
    schedulerMock.on(DeleteScheduleCommand).rejects(new Error('unexpected'));
    const { deleteReminderSchedule } = await import('../../../src/lib/scheduler-client.js');
    await expect(deleteReminderSchedule('deadline-x')).rejects.toThrow('unexpected');
  });
});

describe('env var validation', () => {
  let savedGroup: string | undefined;
  let savedRole: string | undefined;
  let savedArn: string | undefined;

  beforeEach(() => {
    savedGroup = process.env.SCHEDULER_GROUP_NAME;
    savedRole = process.env.SCHEDULER_ROLE_ARN;
    savedArn = process.env.LAMBDA_FUNCTION_ARN;
  });

  afterEach(() => {
    if (savedGroup === undefined) {
      delete process.env.SCHEDULER_GROUP_NAME;
    } else {
      process.env.SCHEDULER_GROUP_NAME = savedGroup;
    }
    if (savedRole === undefined) {
      delete process.env.SCHEDULER_ROLE_ARN;
    } else {
      process.env.SCHEDULER_ROLE_ARN = savedRole;
    }
    if (savedArn === undefined) {
      delete process.env.LAMBDA_FUNCTION_ARN;
    } else {
      process.env.LAMBDA_FUNCTION_ARN = savedArn;
    }
  });

  it('createReminderSchedule throws when SCHEDULER_GROUP_NAME is missing', async () => {
    delete process.env.SCHEDULER_GROUP_NAME;
    const { createReminderSchedule } = await import('../../../src/lib/scheduler-client.js');
    await expect(
      createReminderSchedule({
        scheduleName: 'deadline-x',
        scheduledFor: new Date('2027-01-01T00:00:00Z'),
        payload: { deadlineNotificationId: 'x', reminderType: 't_minus_30' },
      }),
    ).rejects.toThrow(/SCHEDULER_GROUP_NAME.*SCHEDULER_ROLE_ARN.*LAMBDA_FUNCTION_ARN/);
  });

  it('deleteReminderSchedule throws when SCHEDULER_GROUP_NAME is missing', async () => {
    delete process.env.SCHEDULER_GROUP_NAME;
    const { deleteReminderSchedule } = await import('../../../src/lib/scheduler-client.js');
    await expect(deleteReminderSchedule('deadline-x')).rejects.toThrow(/SCHEDULER_GROUP_NAME/);
  });
});
