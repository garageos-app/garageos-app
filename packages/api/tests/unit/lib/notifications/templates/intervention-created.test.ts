import { describe, expect, it } from 'vitest';
import {
  CREATED_EMAIL_SUBJECT,
  renderCreatedEmailHtml,
  renderCreatedEmailText,
} from '../../../../../src/lib/notifications/templates/intervention-created.js';
import type {
  CustomerForNotification,
  InterventionForEmail,
  TenantForEmail,
  VehicleForCreatedEmail,
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
  description: 'Sostituzione olio motore',
  cancelledReason: null,
};

const vehicle: VehicleForCreatedEmail = {
  id: 'veh-1',
  plate: 'GG123ZZ',
  make: 'Fiat',
  model: 'Panda',
};

const tenant: TenantForEmail = { id: 'ten-1', businessName: 'Officina Mario S.r.l.' };

const baseInput = { recipient, intervention, interventionTypeName: 'Tagliando', vehicle, tenant };

describe('intervention-created template (BR-157)', () => {
  it('subject contains "nuovo intervento"', () => {
    expect(CREATED_EMAIL_SUBJECT).toMatch(/nuovo intervento/i);
  });

  it('html includes recipient name, tenant, vehicle make/model/plate, type, link', () => {
    const html = renderCreatedEmailHtml(baseInput);
    expect(html).toContain('Mario');
    expect(html).toContain('Officina Mario S.r.l.');
    expect(html).toContain('Fiat');
    expect(html).toContain('Panda');
    expect(html).toContain('GG123ZZ');
    expect(html).toContain('Tagliando');
    expect(html).toContain('https://app.garageos.aifollyadvisor.com/v/veh-1');
  });

  it('html escapes markup in tenant name', () => {
    const html = renderCreatedEmailHtml({
      ...baseInput,
      tenant: { id: 'ten-1', businessName: 'Officina <b>X</b>' },
    });
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
  });

  it('text mirrors html content', () => {
    const text = renderCreatedEmailText(baseInput);
    expect(text).toContain('Mario');
    expect(text).toContain('Officina Mario S.r.l.');
    expect(text).toContain('Fiat Panda');
    expect(text).toContain('GG123ZZ');
    expect(text).toContain('Tagliando');
  });

  it('uses businessName for business recipients and Cliente fallback', () => {
    const business = renderCreatedEmailHtml({
      ...baseInput,
      recipient: { ...recipient, isBusiness: true, businessName: 'ACME S.p.A.' },
    });
    expect(business).toContain('ACME S.p.A.');
    const anonymous = renderCreatedEmailHtml({
      ...baseInput,
      recipient: { ...recipient, firstName: null },
    });
    expect(anonymous).toContain('Cliente');
  });
});
