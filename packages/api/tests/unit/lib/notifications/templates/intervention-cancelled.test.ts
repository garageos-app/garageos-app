import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_EMAIL_SUBJECT,
  renderCancellationEmailHtml,
  renderCancellationEmailText,
} from '../../../../../src/lib/notifications/templates/intervention-cancelled.js';
import type {
  CustomerForNotification,
  InterventionForEmail,
  TenantForEmail,
  UserDisplayName,
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

const intervention: InterventionForEmail = {
  id: 'int-1',
  vehicleId: 'veh-1',
  title: 'Tagliando',
  description: 'Sostituzione olio motore',
  cancelledReason: 'Errore di trascrizione VIN — la riga è stata reinserita corretta.',
};

const tenant: TenantForEmail = { id: 'ten-1', nameLegal: 'Officina Mario S.r.l.' };
const cancelledBy: UserDisplayName = { firstName: 'Luigi', lastName: 'Bianchi' };

describe('intervention-cancelled template', () => {
  it('subject contains "annullato"', () => {
    expect(CANCELLATION_EMAIL_SUBJECT).toMatch(/annullat/i);
  });

  it('html includes recipient name, tenant, cancelled reason, vehicle link', () => {
    const html = renderCancellationEmailHtml({ recipient, intervention, tenant, cancelledBy });
    expect(html).toContain('Mario');
    expect(html).toContain('Officina Mario S.r.l.');
    expect(html).toContain('Errore di trascrizione VIN');
    expect(html).toContain('https://app.garageos.aifollyadvisor.com/v/veh-1');
  });

  it('text mirrors html content', () => {
    const text = renderCancellationEmailText({ recipient, intervention, tenant, cancelledBy });
    expect(text).toContain('Mario');
    expect(text).toContain('Officina Mario S.r.l.');
    expect(text).toContain('Errore di trascrizione VIN');
  });

  it('handles null cancelledReason without leaking null/undefined', () => {
    const html = renderCancellationEmailHtml({
      recipient,
      intervention: { ...intervention, cancelledReason: null },
      tenant,
      cancelledBy,
    });
    // Word-boundary anchored to avoid matching "annullato" (BR-066 Italian).
    expect(html).not.toMatch(/\bnull\b|\bundefined\b/i);
  });
});
