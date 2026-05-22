import { describe, expect, it } from 'vitest';

import type { CustomerForNotification } from '../../../../../src/lib/notifications/types.js';
import {
  OWNERSHIP_TRANSFERRED_SUBJECT,
  renderOwnershipTransferredHtml,
  renderOwnershipTransferredText,
} from '../../../../../src/lib/notifications/templates/ownership-transferred.js';

const individual: CustomerForNotification = {
  id: 'c-1',
  email: 'mario@test.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
  notificationPreferences: {},
  status: 'active',
};

const business: CustomerForNotification = {
  ...individual,
  id: 'c-2',
  isBusiness: true,
  businessName: 'Autotrasporti Rossi SRL',
};

const baseInput = {
  recipient: individual,
  vehicle: { id: 'veh-1', plate: 'AB123CD' },
  tenant: { id: 't-1', businessName: 'Officina Bianchi' },
  transferReason: 'purchase' as const,
  transferredAt: '2026-05-22T10:30:00.000Z',
};

describe('ownership-transferred template', () => {
  it('subject is the fixed Italian string', () => {
    expect(OWNERSHIP_TRANSFERRED_SUBJECT).toBe('La proprietà del tuo veicolo è stata trasferita');
  });

  it('html greets the individual by first name and shows plate, officina, date, reason', () => {
    const html = renderOwnershipTransferredHtml(baseInput);
    expect(html).toContain('Ciao Mario,');
    expect(html).toContain('AB123CD');
    expect(html).toContain('Officina Bianchi');
    expect(html).toContain('22/05/2026');
    expect(html).toContain('Vendita');
    expect(html).toContain('non avrai più accesso allo storico');
  });

  it('html greets a business recipient by business name', () => {
    const html = renderOwnershipTransferredHtml({ ...baseInput, recipient: business });
    expect(html).toContain('Ciao Autotrasporti Rossi SRL,');
  });

  it('localizes every reason', () => {
    const reasons = [
      ['purchase', 'Vendita'],
      ['inheritance', 'Eredità'],
      ['company_assignment', 'Assegnazione aziendale'],
      ['other', 'Altro'],
    ] as const;
    for (const [reason, label] of reasons) {
      expect(renderOwnershipTransferredText({ ...baseInput, transferReason: reason })).toContain(
        label,
      );
    }
  });

  it('escapes HTML in interpolated values', () => {
    const html = renderOwnershipTransferredHtml({
      ...baseInput,
      tenant: { id: 't-1', businessName: '<script>x</script>' },
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not contain an app deep link', () => {
    const html = renderOwnershipTransferredHtml(baseInput);
    expect(html).not.toContain('app.garageos');
  });
});
