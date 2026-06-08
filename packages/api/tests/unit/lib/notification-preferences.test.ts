import { describe, expect, it } from 'vitest';

import { projectNotificationPreferences } from '../../../src/lib/notification-preferences.js';

const EMAIL_DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
  marketing: false,
};
const PUSH_DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
};

describe('projectNotificationPreferences', () => {
  it('returns email + push defaults for an empty object', () => {
    expect(projectNotificationPreferences({})).toEqual({
      email: EMAIL_DEFAULTS,
      push: PUSH_DEFAULTS,
    });
  });

  it('returns defaults for null / non-object / malformed json', () => {
    const expected = { email: EMAIL_DEFAULTS, push: PUSH_DEFAULTS };
    expect(projectNotificationPreferences(null)).toEqual(expected);
    expect(projectNotificationPreferences('nope')).toEqual(expected);
    expect(projectNotificationPreferences([1, 2])).toEqual(expected);
    expect(projectNotificationPreferences({ email: 'bad', push: 'bad' })).toEqual(expected);
  });

  it('reflects partial email + push overrides and fills the rest from defaults', () => {
    expect(
      projectNotificationPreferences({
        email: { intervention_updates: false, marketing: true },
        push: { deadline_reminder: false },
      }),
    ).toEqual({
      email: { ...EMAIL_DEFAULTS, intervention_updates: false, marketing: true },
      push: { ...PUSH_DEFAULTS, deadline_reminder: false },
    });
  });

  it('ignores non-boolean values and non-editable keys on both channels', () => {
    expect(
      projectNotificationPreferences({
        email: { deadline_reminder: 'yes', transfer_invitation: false, dispute_response: false },
        push: { ownership_transfer: 'no', transfer_invitation: false, dispute_response: false },
      }),
    ).toEqual({ email: EMAIL_DEFAULTS, push: PUSH_DEFAULTS });
  });
});
