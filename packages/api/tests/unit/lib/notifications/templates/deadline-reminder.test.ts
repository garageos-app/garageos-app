import { beforeAll, describe, expect, it } from 'vitest';

import {
  renderDeadlineReminderHtml,
  renderDeadlineReminderSubject,
  renderDeadlineReminderText,
} from '../../../../../src/lib/notifications/templates/deadline-reminder.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../../src/lib/notifications/types.js';

beforeAll(() => {
  process.env.WEB_APP_BASE_URL = 'https://app.garageos.aifollyadvisor.com';
});

const recipient: CustomerForNotification = {
  id: 'c1',
  email: 'mario@example.com',
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
  status: 'active',
  notificationPreferences: { email: { deadline_reminder: true } },
};

const baseEvent: Extract<NotificationEvent, { type: 'deadline.reminder' }> = {
  type: 'deadline.reminder',
  deadlineId: 'd1',
  reminderType: 't_minus_30',
  dueDate: '2026-12-31',
  dueOdometerKm: null,
  vehicleId: 'v1',
  vehicleLicensePlate: 'AB123CD',
  interventionTypeName: 'Revisione',
  description: 'Revisione obbligatoria 4 anni',
};

describe('renderDeadlineReminderSubject', () => {
  it('produces t_minus_30 subject', () => {
    expect(renderDeadlineReminderSubject({ ...baseEvent, reminderType: 't_minus_30' })).toBe(
      'Promemoria: scadenza Revisione fra 30 giorni — AB123CD',
    );
  });

  it('produces t_minus_7 subject', () => {
    expect(renderDeadlineReminderSubject({ ...baseEvent, reminderType: 't_minus_7' })).toBe(
      'Promemoria urgente: Revisione scade fra 7 giorni — AB123CD',
    );
  });

  it('produces t_zero subject', () => {
    expect(renderDeadlineReminderSubject({ ...baseEvent, reminderType: 't_zero' })).toBe(
      'Oggi scade: Revisione — AB123CD',
    );
  });

  it('produces km_reached subject', () => {
    expect(renderDeadlineReminderSubject({ ...baseEvent, reminderType: 'km_reached' })).toBe(
      'Promemoria: Revisione — AB123CD',
    );
  });
});

describe('renderDeadlineReminderHtml', () => {
  it('includes plate, intervention type, italian-formatted due date, vehicle link, recipient name', () => {
    const html = renderDeadlineReminderHtml({ recipient, event: baseEvent });
    expect(html).toContain('AB123CD');
    expect(html).toContain('Revisione');
    expect(html).toContain('31 dicembre 2026');
    expect(html).toContain('Revisione obbligatoria 4 anni');
    expect(html).toContain('https://app.garageos.aifollyadvisor.com/vehicles/v1');
    expect(html).toContain('Ciao Mario');
  });

  it('renders dueOdometerKm when provided', () => {
    const html = renderDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, dueOdometerKm: 100000 },
    });
    expect(html).toContain('100.000 km');
  });

  it('omits the description block when description is null', () => {
    const html = renderDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, description: null },
    });
    expect(html).not.toContain('class="description"');
  });

  it('uses business greeting for business recipient', () => {
    const bizRecipient: CustomerForNotification = {
      ...recipient,
      isBusiness: true,
      businessName: 'Autonoleggio Rossi S.r.l.',
      firstName: null,
    };
    const html = renderDeadlineReminderHtml({ recipient: bizRecipient, event: baseEvent });
    expect(html).toContain('Buongiorno Autonoleggio Rossi S.r.l.');
  });

  it('uses generic greeting when no name is available', () => {
    const anonymousRecipient: CustomerForNotification = {
      ...recipient,
      firstName: null,
      isBusiness: false,
      businessName: null,
    };
    const html = renderDeadlineReminderHtml({ recipient: anonymousRecipient, event: baseEvent });
    expect(html).toContain('Buongiorno,');
  });

  it('does not leak null or undefined into the output', () => {
    const html = renderDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, description: null, dueOdometerKm: null },
    });
    expect(html).not.toMatch(/\bnull\b|\bundefined\b/i);
  });
});

describe('renderDeadlineReminderText', () => {
  it('produces a plain-text body with plate, type, italian date, link', () => {
    const text = renderDeadlineReminderText({ recipient, event: baseEvent });
    expect(text).toContain('AB123CD');
    expect(text).toContain('Revisione');
    expect(text).toContain('31 dicembre 2026');
    expect(text).toContain('https://app.garageos.aifollyadvisor.com/vehicles/v1');
  });

  it('includes description when present', () => {
    const text = renderDeadlineReminderText({ recipient, event: baseEvent });
    expect(text).toContain('Revisione obbligatoria 4 anni');
  });

  it('omits description block when null', () => {
    const text = renderDeadlineReminderText({
      recipient,
      event: { ...baseEvent, description: null },
    });
    expect(text).not.toContain('null');
  });

  it('includes km line when dueOdometerKm is provided', () => {
    const text = renderDeadlineReminderText({
      recipient,
      event: { ...baseEvent, dueOdometerKm: 150000 },
    });
    expect(text).toContain('150.000 km');
  });
});
