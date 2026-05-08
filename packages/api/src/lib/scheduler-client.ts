import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';

// DeadlineReminderType mirrors the Prisma-generated enum values (enums.ts).
// We redeclare it here as a string union to avoid a direct import from the
// generated output path; the shape must stay in sync with the DB enum.
// See: packages/database/prisma/generated/prisma/client/enums.ts
export type DeadlineReminderType = 't_minus_30' | 't_minus_7' | 't_zero' | 'km_reached';

// Lazy singleton — same pattern as lib/ses-client.ts. Tests use
// `_resetSchedulerClientForTests` to force aws-sdk-client-mock to intercept
// the client on every test setup.
let _client: SchedulerClient | null = null;

export function getSchedulerClient(): SchedulerClient {
  if (_client) return _client;
  _client = new SchedulerClient({});
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetSchedulerClientForTests(): void {
  _client = null;
}

export interface ReminderScheduleParams {
  scheduleName: string;
  scheduledFor: Date;
  payload: {
    deadlineNotificationId: string;
    reminderType: DeadlineReminderType;
  };
}

/**
 * Formats a Date as the EventBridge Scheduler `at()` expression.
 * Milliseconds are stripped because the Scheduler service rejects them.
 * Output format: `at(YYYY-MM-DDTHH:mm:ss)` (UTC, no trailing Z).
 */
function formatAtExpression(date: Date): string {
  const iso = date.toISOString();
  // toISOString always emits .NNNZ; strip both, plus a standalone Z as defense
  // against any future code path that emits second-precision ISO without ms.
  // AWS Scheduler at() syntax rejects both ms and Z suffix.
  const trimmed = iso.replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
  return `at(${trimmed})`;
}

/**
 * Creates a one-time EventBridge Scheduler schedule that invokes the API
 * Lambda with a structured payload at the given UTC time.
 *
 * Env vars required:
 *   SCHEDULER_GROUP_NAME  — schedule group (e.g. `garageos-deadlines`)
 *   SCHEDULER_ROLE_ARN    — IAM role the scheduler assumes to invoke Lambda
 *   LAMBDA_FUNCTION_ARN   — target Lambda ARN (the api function itself)
 *
 * Returns the ScheduleArn of the created schedule.
 */
export async function createReminderSchedule(params: ReminderScheduleParams): Promise<string> {
  const groupName = process.env.SCHEDULER_GROUP_NAME;
  const roleArn = process.env.SCHEDULER_ROLE_ARN;
  const targetArn = process.env.LAMBDA_FUNCTION_ARN;
  if (!groupName || !roleArn || !targetArn) {
    throw new Error(
      'scheduler-client: SCHEDULER_GROUP_NAME, SCHEDULER_ROLE_ARN and LAMBDA_FUNCTION_ARN env vars are required',
    );
  }

  const command = new CreateScheduleCommand({
    Name: params.scheduleName,
    GroupName: groupName,
    ScheduleExpression: formatAtExpression(params.scheduledFor),
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: targetArn,
      RoleArn: roleArn,
      Input: JSON.stringify({
        source: 'aws.scheduler',
        detail: {
          deadlineNotificationId: params.payload.deadlineNotificationId,
          reminderType: params.payload.reminderType,
        },
      }),
      RetryPolicy: { MaximumRetryAttempts: 3 },
    },
    // Auto-delete the schedule after it fires — avoids stale schedule accumulation.
    ActionAfterCompletion: 'DELETE',
  });

  const result = await getSchedulerClient().send(command);
  if (!result.ScheduleArn) {
    throw new Error(
      'scheduler-client: CreateSchedule succeeded but ScheduleArn missing in response',
    );
  }
  return result.ScheduleArn;
}

/**
 * Deletes a reminder schedule by name. Idempotent: a missing schedule
 * (ResourceNotFoundException) is silently swallowed so compensating actions
 * and retries on partial AWS failures are safe.
 *
 * Env vars required:
 *   SCHEDULER_GROUP_NAME  — schedule group (must match the group used at create)
 */
export async function deleteReminderSchedule(scheduleName: string): Promise<void> {
  const groupName = process.env.SCHEDULER_GROUP_NAME;
  if (!groupName) {
    throw new Error('scheduler-client: SCHEDULER_GROUP_NAME env var is required');
  }
  try {
    await getSchedulerClient().send(
      new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: groupName,
      }),
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return;
    }
    throw err;
  }
}
