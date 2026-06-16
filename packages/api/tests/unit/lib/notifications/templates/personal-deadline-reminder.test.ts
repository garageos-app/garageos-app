import { describe, expect, it } from 'vitest';

import {
  personalDeadlineLabel,
  renderPersonalDeadlineReminderHtml,
  renderPersonalDeadlineReminderSubject,
  renderPersonalDeadlineReminderText,
} from '../../../../../src/lib/notifications/templates/personal-deadline-reminder.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../../src/lib/notifications/types.js';

const recipient: CustomerForNotification = {
  id: 'cust-1',
  email: 'mario@test.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
  notificationPreferences: {},
  status: 'active',
};

const baseEvent: Extract<NotificationEvent, { type: 'personal_deadline.reminder' }> = {
  type: 'personal_deadline.reminder',
  personalDeadlineId: 'pd-1',
  category: 'inspection',
  customLabel: null,
  dueDate: '2026-09-15',
  vehiclePlate: 'AB123CD',
  vehicleMakeModel: 'Fiat Panda',
  kind: 'lead',
  daysUntilDue: 7,
};

describe('personalDeadlineLabel', () => {
  it('returns Italian name for a known category', () => {
    expect(personalDeadlineLabel({ ...baseEvent, category: 'inspection' })).toBe('Revisione');
    expect(personalDeadlineLabel({ ...baseEvent, category: 'insurance' })).toBe('Assicurazione');
    expect(personalDeadlineLabel({ ...baseEvent, category: 'road_tax' })).toBe('Bollo');
    expect(personalDeadlineLabel({ ...baseEvent, category: 'service' })).toBe('Tagliando');
    expect(personalDeadlineLabel({ ...baseEvent, category: 'tires' })).toBe('Pneumatici');
    expect(personalDeadlineLabel({ ...baseEvent, category: 'timing_belt' })).toBe(
      'Cinghia di distribuzione',
    );
  });

  it('returns customLabel for category "other"', () => {
    expect(
      personalDeadlineLabel({ ...baseEvent, category: 'other', customLabel: 'Tagliando speciale' }),
    ).toBe('Tagliando speciale');
  });

  it('falls back to generic label when category is "other" but customLabel is null', () => {
    const label = personalDeadlineLabel({ ...baseEvent, category: 'other', customLabel: null });
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/null|undefined/i);
  });
});

describe('renderPersonalDeadlineReminderSubject', () => {
  it('contains the Italian category label and the vehicle plate', () => {
    const subject = renderPersonalDeadlineReminderSubject(baseEvent);
    expect(subject).toContain('Revisione');
    expect(subject).toContain('AB123CD');
  });

  it('uses customLabel in subject when category is "other"', () => {
    const subject = renderPersonalDeadlineReminderSubject({
      ...baseEvent,
      category: 'other',
      customLabel: 'Polizza kasko',
    });
    expect(subject).toContain('Polizza kasko');
    expect(subject).toContain('AB123CD');
  });
});

describe('renderPersonalDeadlineReminderHtml daysUntilDue phrasings', () => {
  it('daysUntilDue > 1: plural "giorni"', () => {
    const html = renderPersonalDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, daysUntilDue: 7 },
    });
    expect(html).toContain('7 giorni');
  });

  it('daysUntilDue === 1: singular "1 giorno"', () => {
    const html = renderPersonalDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, daysUntilDue: 1 },
    });
    expect(html).toContain('1 giorno');
    expect(html).not.toContain('1 giorni');
  });

  it('daysUntilDue === 0: "Scade oggi"', () => {
    const html = renderPersonalDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, daysUntilDue: 0 },
    });
    expect(html).toContain('Scade oggi');
  });

  it('daysUntilDue < 0: "Era in scadenza il" with formatted date', () => {
    const html = renderPersonalDeadlineReminderHtml({
      recipient,
      event: { ...baseEvent, daysUntilDue: -2, dueDate: '2026-09-15' },
    });
    expect(html).toContain('Era in scadenza il');
    // DD/MM/YYYY format
    expect(html).toContain('15/09/2026');
  });
});

describe('renderPersonalDeadlineReminderHtml content', () => {
  it('includes vehicle plate in html', () => {
    const html = renderPersonalDeadlineReminderHtml({ recipient, event: baseEvent });
    expect(html).toContain('AB123CD');
  });

  it('includes vehicleMakeModel in html', () => {
    const html = renderPersonalDeadlineReminderHtml({ recipient, event: baseEvent });
    expect(html).toContain('Fiat Panda');
  });

  it('escapes customLabel containing HTML special chars', () => {
    const html = renderPersonalDeadlineReminderHtml({
      recipient,
      event: {
        ...baseEvent,
        category: 'other',
        customLabel: '<script>alert("xss")</script> & more',
      },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('uses businessName for business recipients', () => {
    const bizRecipient: CustomerForNotification = {
      ...recipient,
      isBusiness: true,
      businessName: 'ACME S.p.A.',
      firstName: null,
    };
    const html = renderPersonalDeadlineReminderHtml({ recipient: bizRecipient, event: baseEvent });
    expect(html).toContain('ACME S.p.A.');
  });

  it('falls back to "Cliente" when no name available', () => {
    const anonRecipient: CustomerForNotification = {
      ...recipient,
      firstName: null,
      isBusiness: false,
      businessName: null,
    };
    const html = renderPersonalDeadlineReminderHtml({ recipient: anonRecipient, event: baseEvent });
    expect(html).toContain('Cliente');
  });

  it('does not leak null or undefined', () => {
    const html = renderPersonalDeadlineReminderHtml({ recipient, event: baseEvent });
    expect(html).not.toMatch(/\bnull\b|\bundefined\b/i);
  });
});

describe('renderPersonalDeadlineReminderText', () => {
  it('includes vehicle plate', () => {
    const text = renderPersonalDeadlineReminderText({ recipient, event: baseEvent });
    expect(text).toContain('AB123CD');
  });

  it('includes vehicleMakeModel', () => {
    const text = renderPersonalDeadlineReminderText({ recipient, event: baseEvent });
    expect(text).toContain('Fiat Panda');
  });

  it('daysUntilDue === 1 uses singular in plain text', () => {
    const text = renderPersonalDeadlineReminderText({
      recipient,
      event: { ...baseEvent, daysUntilDue: 1 },
    });
    expect(text).toContain('1 giorno');
    expect(text).not.toContain('1 giorni');
  });

  it('daysUntilDue === 0: "Scade oggi" in plain text', () => {
    const text = renderPersonalDeadlineReminderText({
      recipient,
      event: { ...baseEvent, daysUntilDue: 0 },
    });
    expect(text).toContain('Scade oggi');
  });

  it('daysUntilDue < 0: "Era in scadenza il" in plain text', () => {
    const text = renderPersonalDeadlineReminderText({
      recipient,
      event: { ...baseEvent, daysUntilDue: -2, dueDate: '2026-09-15' },
    });
    expect(text).toContain('Era in scadenza il');
    expect(text).toContain('15/09/2026');
  });

  it('does not leak null or undefined', () => {
    const text = renderPersonalDeadlineReminderText({ recipient, event: baseEvent });
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/i);
  });
});
