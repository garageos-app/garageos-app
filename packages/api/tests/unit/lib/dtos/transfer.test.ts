import { describe, expect, it } from 'vitest';

import { serializeTransfer } from '../../../../src/lib/dtos/transfer.js';

const baseRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  vehicleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  method: 'initiated_by_seller' as const,
  status: 'pending_recipient' as const,
  transferCode: 'TR-9K4M-7P2X',
  expiresAt: new Date('2026-06-16T14:32:05.000Z'),
  completedAt: null,
  rejectedReason: null,
  createdAt: new Date('2026-06-09T14:32:05.000Z'),
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
};

describe('serializeTransfer', () => {
  it('maps initiated_by_seller to physical_code and serializes dates as ISO', () => {
    expect(serializeTransfer(baseRow)).toEqual({
      id: baseRow.id,
      vehicleId: baseRow.vehicleId,
      vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      method: 'physical_code',
      status: 'pending_recipient',
      transferCode: 'TR-9K4M-7P2X',
      expiresAt: '2026-06-16T14:32:05.000Z',
      createdAt: '2026-06-09T14:32:05.000Z',
    });
  });

  it('omits completedAt/rejectedReason when null', () => {
    const dto = serializeTransfer(baseRow);
    expect(dto).not.toHaveProperty('completedAt');
    expect(dto).not.toHaveProperty('rejectedReason');
  });

  it('includes completedAt/rejectedReason when present', () => {
    const dto = serializeTransfer({
      ...baseRow,
      status: 'rejected',
      completedAt: new Date('2026-06-10T00:00:00.000Z'),
      rejectedReason: 'cambiato idea',
    });
    expect(dto.completedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(dto.rejectedReason).toBe('cambiato idea');
  });
});
