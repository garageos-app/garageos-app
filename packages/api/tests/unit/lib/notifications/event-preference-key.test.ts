import { describe, expect, it } from 'vitest';

import { preferenceKeyForEvent } from '../../../../src/lib/notifications/event-preference-key.js';
import type { NotificationEvent } from '../../../../src/lib/notifications/types.js';

const tenant = { id: 't', businessName: 'O' };

it('maps intervention.created to intervention_updates (BR-226 v1.3)', () => {
  const created: NotificationEvent = {
    type: 'intervention.created',
    intervention: {
      id: 'i',
      vehicleId: 'v',
      title: null,
      description: null,
      cancelledReason: null,
    },
    interventionTypeName: 'Tagliando',
    vehicle: { id: 'v', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
    tenant,
  };
  expect(preferenceKeyForEvent(created)).toBe('intervention_updates');
});

it('maps intervention.revised and cancelled to intervention_updates', () => {
  const revised: NotificationEvent = {
    type: 'intervention.revised',
    intervention: {
      id: 'i',
      vehicleId: 'v',
      title: null,
      description: null,
      cancelledReason: null,
    },
    revision: { id: 'r', revisedAt: new Date(), reason: null, changes: {} },
    tenant,
  };
  const cancelled: NotificationEvent = {
    type: 'intervention.cancelled',
    intervention: {
      id: 'i',
      vehicleId: 'v',
      title: null,
      description: null,
      cancelledReason: null,
    },
    tenant,
  };
  expect(preferenceKeyForEvent(revised)).toBe('intervention_updates');
  expect(preferenceKeyForEvent(cancelled)).toBe('intervention_updates');
});

it('maps deadline.reminder and ownership.transferred', () => {
  const deadline: NotificationEvent = {
    type: 'deadline.reminder',
    deadlineId: 'd',
    reminderType: 't_minus_30',
    dueDate: '2026-12-31',
    dueOdometerKm: null,
    vehicleId: 'v',
    vehicleLicensePlate: 'AB123CD',
    interventionTypeName: 'Revisione',
    description: null,
  };
  const transfer: NotificationEvent = {
    type: 'ownership.transferred',
    vehicle: { id: 'v', plate: 'AB123CD' },
    tenant,
    transferReason: 'purchase',
    transferredAt: '2026-05-22T10:30:00.000Z',
  };
  expect(preferenceKeyForEvent(deadline)).toBe('deadline_reminder');
  expect(preferenceKeyForEvent(transfer)).toBe('ownership_transfer');
});

it('maps personal_deadline.reminder to personal_deadline_reminder (BR-297)', () => {
  const event: NotificationEvent = {
    type: 'personal_deadline.reminder',
    personalDeadlineId: 'pd-1',
    category: 'insurance',
    customLabel: null,
    dueDate: '2026-12-31',
    vehiclePlate: 'AB123CD',
    vehicleMakeModel: 'Fiat Panda',
    kind: 'lead',
    daysUntilDue: 7,
  };
  expect(preferenceKeyForEvent(event)).toBe('personal_deadline_reminder');
});

describe('preferenceKeyForEvent', () => {
  it('is a function', () => expect(typeof preferenceKeyForEvent).toBe('function'));
});
