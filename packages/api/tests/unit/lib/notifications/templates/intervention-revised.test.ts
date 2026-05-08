import { describe, expect, it } from 'vitest';
import {
  REVISION_EMAIL_SUBJECT,
  renderRevisionEmailHtml,
  renderRevisionEmailText,
} from '../../../../../src/lib/notifications/templates/intervention-revised.js';
import type {
  CustomerForNotification,
  InterventionForEmail,
  RevisionForEmail,
  TenantForEmail,
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
  cancelledReason: null,
};

const revision: RevisionForEmail = {
  id: 'rev-1',
  revisedAt: new Date('2026-05-08T10:00:00Z'),
  reason: 'Correzione km',
  changes: { odometerKm: { from: 50000, to: 51000 } },
};

const tenant: TenantForEmail = { id: 'ten-1', businessName: 'Officina Mario S.r.l.' };

describe('intervention-revised template', () => {
  it('subject contains "modificato"', () => {
    expect(REVISION_EMAIL_SUBJECT).toMatch(/modificat/i);
  });

  it('html includes recipient firstName, vehicle link, tenant name, revision reason', () => {
    const html = renderRevisionEmailHtml({ recipient, intervention, revision, tenant });
    expect(html).toContain('Mario');
    expect(html).toContain('Officina Mario S.r.l.');
    expect(html).toContain('Correzione km');
    expect(html).toContain('https://app.garageos.aifollyadvisor.com/v/veh-1');
  });

  it('text mirrors html content (plain version)', () => {
    const text = renderRevisionEmailText({ recipient, intervention, revision, tenant });
    expect(text).toContain('Mario');
    expect(text).toContain('Officina Mario S.r.l.');
    expect(text).toContain('Correzione km');
    expect(text).toContain('https://app.garageos.aifollyadvisor.com/v/veh-1');
  });

  it('uses business name when recipient is_business=true', () => {
    const business: CustomerForNotification = {
      ...recipient,
      isBusiness: true,
      businessName: 'Trasporti Rossi S.p.A.',
    };
    const html = renderRevisionEmailHtml({ recipient: business, intervention, revision, tenant });
    expect(html).toContain('Trasporti Rossi S.p.A.');
  });

  it('handles null revision.reason gracefully', () => {
    const html = renderRevisionEmailHtml({
      recipient,
      intervention,
      revision: { ...revision, reason: null },
      tenant,
    });
    // No undefined/null leakage in body.
    expect(html).not.toMatch(/null|undefined/i);
  });
});
