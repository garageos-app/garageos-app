import {
  TRANSFER_STATUS_LABELS,
  isTransferActive,
  transferStatusTone,
  transferShareMessage,
} from '@/lib/transfer-labels';
import type { Transfer } from '@/lib/types/transfer';

describe('transfer labels', () => {
  it('maps every status to the Italian label from the spec', () => {
    expect(TRANSFER_STATUS_LABELS.pending_recipient).toBe('In attesa del nuovo proprietario');
    expect(TRANSFER_STATUS_LABELS.pending_seller_confirmation).toBe('In attesa della tua conferma');
    expect(TRANSFER_STATUS_LABELS.completed).toBe('Completato');
    expect(TRANSFER_STATUS_LABELS.rejected).toBe('Rifiutato');
    expect(TRANSFER_STATUS_LABELS.expired).toBe('Scaduto');
  });

  it('isTransferActive is true only for pending statuses', () => {
    expect(isTransferActive('pending_recipient')).toBe(true);
    expect(isTransferActive('pending_seller_confirmation')).toBe(true);
    expect(isTransferActive('pending_validation')).toBe(true);
    expect(isTransferActive('completed')).toBe(false);
    expect(isTransferActive('rejected')).toBe(false);
    expect(isTransferActive('expired')).toBe(false);
  });

  it('transferStatusTone buckets statuses for badge styling', () => {
    expect(transferStatusTone('pending_recipient')).toBe('pending');
    expect(transferStatusTone('completed')).toBe('done');
    expect(transferStatusTone('rejected')).toBe('closed');
    expect(transferStatusTone('expired')).toBe('closed');
  });

  it('transferShareMessage includes code, vehicle and expiry date', () => {
    const t: Transfer = {
      id: 'x',
      vehicleId: 'v',
      vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      method: 'physical_code',
      status: 'pending_recipient',
      transferCode: 'TR-ABCD-2345',
      expiresAt: '2026-06-17T10:00:00.000Z',
      createdAt: '2026-06-10T10:00:00.000Z',
    };
    const msg = transferShareMessage(t);
    expect(msg).toContain('TR-ABCD-2345');
    expect(msg).toContain('Fiat Panda');
    expect(msg).toContain('AB123CD');
    expect(msg).toContain('17/06/2026');
  });
});
