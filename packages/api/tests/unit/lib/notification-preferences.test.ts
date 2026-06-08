import { describe, expect, it } from 'vitest';

import { projectNotificationPreferences } from '../../../src/lib/notification-preferences.js';

describe('projectNotificationPreferences', () => {
  it('returns all 4 defaults for an empty object', () => {
    expect(projectNotificationPreferences({})).toEqual({
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    });
  });

  it('returns defaults for null / non-object / malformed json', () => {
    const expected = {
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    };
    expect(projectNotificationPreferences(null)).toEqual(expected);
    expect(projectNotificationPreferences('nope')).toEqual(expected);
    expect(projectNotificationPreferences([1, 2])).toEqual(expected);
    expect(projectNotificationPreferences({ email: 'bad' })).toEqual(expected);
  });

  it('reflects a partial override and fills the rest from defaults', () => {
    expect(
      projectNotificationPreferences({
        email: { intervention_updates: false, marketing: true },
      }),
    ).toEqual({
      email: {
        intervention_updates: false,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: true,
      },
    });
  });

  it('ignores non-boolean values and non-editable keys', () => {
    expect(
      projectNotificationPreferences({
        email: {
          deadline_reminder: 'yes',
          transfer_invitation: false,
          dispute_response: false,
        },
        push: { intervention_updates: false },
      }),
    ).toEqual({
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    });
  });
});
