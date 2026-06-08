import { describe, expect, it } from 'vitest';

import { renderPushPayload } from '../../../../src/lib/notifications/push-templates.js';
import type { NotificationEvent } from '../../../../src/lib/notifications/types.js';

const tenant = { id: 't', businessName: 'Officina Mario' };

it('renders intervention.revised with ids in data', () => {
  const event: NotificationEvent = {
    type: 'intervention.revised',
    intervention: {
      id: 'int-1',
      vehicleId: 'veh-1',
      title: 'Tagliando',
      description: null,
      cancelledReason: null,
    },
    revision: { id: 'r', revisedAt: new Date(), reason: null, changes: {} },
    tenant,
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/aggiornat/i);
  expect(p.body).toContain('Officina Mario');
  expect(p.data).toEqual({
    type: 'intervention.revised',
    interventionId: 'int-1',
    vehicleId: 'veh-1',
  });
});

it('renders intervention.cancelled', () => {
  const event: NotificationEvent = {
    type: 'intervention.cancelled',
    intervention: {
      id: 'int-2',
      vehicleId: 'veh-2',
      title: null,
      description: null,
      cancelledReason: 'x',
    },
    tenant,
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/annullat/i);
  expect(p.data).toEqual({
    type: 'intervention.cancelled',
    interventionId: 'int-2',
    vehicleId: 'veh-2',
  });
});

it('renders deadline.reminder with plate and type name', () => {
  const event: NotificationEvent = {
    type: 'deadline.reminder',
    deadlineId: 'd-1',
    reminderType: 't_minus_7',
    dueDate: '2026-12-31',
    dueOdometerKm: null,
    vehicleId: 'veh-3',
    vehicleLicensePlate: 'AB123CD',
    interventionTypeName: 'Revisione',
    description: null,
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/scadenz/i);
  expect(p.body).toContain('AB123CD');
  expect(p.body).toContain('Revisione');
  expect(p.data).toEqual({ type: 'deadline.reminder', deadlineId: 'd-1', vehicleId: 'veh-3' });
});

it('renders ownership.transferred', () => {
  const event: NotificationEvent = {
    type: 'ownership.transferred',
    vehicle: { id: 'veh-4', plate: 'XY987ZK' },
    tenant,
    transferReason: 'purchase',
    transferredAt: '2026-05-22T10:30:00.000Z',
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/trasferit/i);
  expect(p.body).toContain('XY987ZK');
  expect(p.data).toEqual({ type: 'ownership.transferred', vehicleId: 'veh-4' });
});

describe('renderPushPayload', () => {
  it('keeps titles short', () => {
    const event: NotificationEvent = {
      type: 'ownership.transferred',
      vehicle: { id: 'v', plate: 'AB123CD' },
      tenant,
      transferReason: 'other',
      transferredAt: '2026-05-22T10:30:00.000Z',
    };
    expect(renderPushPayload(event).title.length).toBeLessThanOrEqual(40);
  });
});
