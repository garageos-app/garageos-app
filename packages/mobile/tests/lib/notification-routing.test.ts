import { parseNotificationTarget, resolveNotificationTarget } from '@/lib/notification-routing';

const INTERVENTION_ID = '3f9c2a1e-8b4d-4c6a-9e2f-1a7b5d3c8e0f';
const VEHICLE_ID = '7a1d4e9b-2c5f-4a8d-b3e6-9f0c2d5a8b1e';
const DEADLINE_ID = 'c4e8b2a6-1d3f-4b7c-8a9e-5f2d0b6c3a7d';

describe('parseNotificationTarget', () => {
  it('maps intervention.revised to the intervention detail', () => {
    expect(
      parseNotificationTarget({
        type: 'intervention.revised',
        interventionId: INTERVENTION_ID,
        vehicleId: VEHICLE_ID,
      }),
    ).toBe(`/interventions/${INTERVENTION_ID}`);
  });

  it('maps intervention.cancelled to the intervention detail', () => {
    expect(
      parseNotificationTarget({
        type: 'intervention.cancelled',
        interventionId: INTERVENTION_ID,
        vehicleId: VEHICLE_ID,
      }),
    ).toBe(`/interventions/${INTERVENTION_ID}`);
  });

  it('maps deadline.reminder to the deadlines tab with highlight', () => {
    expect(
      parseNotificationTarget({
        type: 'deadline.reminder',
        deadlineId: DEADLINE_ID,
        vehicleId: VEHICLE_ID,
      }),
    ).toBe(`/(tabs)/deadlines?highlight=${DEADLINE_ID}`);
  });

  it('URL-encodes ids interpolated into the href', () => {
    expect(parseNotificationTarget({ type: 'deadline.reminder', deadlineId: 'a/b?c' })).toBe(
      `/(tabs)/deadlines?highlight=${encodeURIComponent('a/b?c')}`,
    );
    expect(parseNotificationTarget({ type: 'intervention.revised', interventionId: 'x y' })).toBe(
      `/interventions/${encodeURIComponent('x y')}`,
    );
  });

  it('maps ownership.transferred to the vehicles list (recipient is the ex owner)', () => {
    expect(parseNotificationTarget({ type: 'ownership.transferred', vehicleId: VEHICLE_ID })).toBe(
      '/(tabs)',
    );
  });

  it.each([
    ['missing interventionId', { type: 'intervention.revised' }],
    ['empty interventionId', { type: 'intervention.revised', interventionId: '' }],
    ['non-string interventionId', { type: 'intervention.cancelled', interventionId: 42 }],
    ['missing deadlineId', { type: 'deadline.reminder', vehicleId: VEHICLE_ID }],
    ['empty deadlineId', { type: 'deadline.reminder', deadlineId: '' }],
  ])('returns null on %s', (_label, data) => {
    expect(parseNotificationTarget(data)).toBeNull();
  });

  it.each([
    ['unknown type', { type: 'something.else', id: 'x' }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'intervention.revised'],
    ['an array', ['intervention.revised']],
    ['empty object', {}],
  ])('returns null on %s', (_label, data) => {
    expect(parseNotificationTarget(data)).toBeNull();
  });
});

describe('resolveNotificationTarget', () => {
  const response = (content: { data?: unknown }, trigger?: unknown) => ({
    notification: { request: { content, trigger } },
  });

  it('resolves from content.data when it carries a routable payload', () => {
    const data = { type: 'intervention.revised', interventionId: INTERVENTION_ID };
    expect(resolveNotificationTarget(response({ data }))).toBe(`/interventions/${INTERVENTION_ID}`);
  });

  it('falls back to trigger.remoteMessage.data.body JSON when content.data is missing', () => {
    const data = { type: 'deadline.reminder', deadlineId: DEADLINE_ID };
    const trigger = { remoteMessage: { data: { body: JSON.stringify(data) } } };
    expect(resolveNotificationTarget(response({}, trigger))).toBe(
      `/(tabs)/deadlines?highlight=${DEADLINE_ID}`,
    );
  });

  it('falls back when content.data is hydrated with non-routable metadata only', () => {
    const data = { type: 'ownership.transferred', vehicleId: VEHICLE_ID };
    const trigger = { remoteMessage: { data: { body: JSON.stringify(data) } } };
    expect(resolveNotificationTarget(response({ data: { experienceId: '@x/y' } }, trigger))).toBe(
      '/(tabs)',
    );
  });

  it('returns null on unparseable remoteMessage body instead of throwing', () => {
    const trigger = { remoteMessage: { data: { body: '{not json' } } };
    expect(resolveNotificationTarget(response({}, trigger))).toBeNull();
  });

  it('returns null when neither source carries a routable payload', () => {
    expect(resolveNotificationTarget(response({}))).toBeNull();
  });
});
