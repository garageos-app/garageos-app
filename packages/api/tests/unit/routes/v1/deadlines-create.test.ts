import { describe, expect, it } from 'vitest';

import { CreateDeadlineSchema } from '@garageos/database';

// F-OFF-401 — unit-test the Zod schema in isolation, without the
// HTTP / preHandler chain. Integration tests in
// tests/integration/deadlines-create.test.ts cover the route end-to-end.

describe('CreateDeadlineSchema (F-OFF-401)', () => {
  function farFutureIso(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 60);
    return d.toISOString().slice(0, 10);
  }

  it('parses a minimal valid payload', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // dueDate is coerced to a Date instance for downstream Prisma use.
      expect(r.data.dueDate).toBeInstanceOf(Date);
      // isRecurring defaults to false.
      expect(r.data.isRecurring).toBe(false);
    }
  });

  it('rejects past dueDate', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: '2020-01-01',
    });
    expect(r.success).toBe(false);
  });

  it('accepts today as dueDate (boundary)', () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: todayIso,
    });
    expect(r.success).toBe(true);
  });

  it('rejects non-uuid interventionTypeId', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: 'not-a-uuid',
      dueDate: farFutureIso(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing interventionTypeId', () => {
    const r = CreateDeadlineSchema.safeParse({
      dueDate: farFutureIso(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects isRecurring=true with no cadence (refine)', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      isRecurring: true,
    });
    expect(r.success).toBe(false);
  });

  it('accepts isRecurring=true with recurringMonths only', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      isRecurring: true,
      recurringMonths: 12,
    });
    expect(r.success).toBe(true);
  });

  it('accepts isRecurring=true with recurringKm only', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      isRecurring: true,
      recurringKm: 15000,
    });
    expect(r.success).toBe(true);
  });

  it('rejects negative dueOdometerKm', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      dueOdometerKm: -1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects description over 500 chars', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      description: 'a'.repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it('rejects recurringMonths over 120', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      isRecurring: true,
      recurringMonths: 121,
    });
    expect(r.success).toBe(false);
  });

  it('accepts a complete payload with sourceInterventionId', () => {
    const r = CreateDeadlineSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      dueDate: farFutureIso(),
      dueOdometerKm: 60000,
      description: 'Tagliando 60k',
      isRecurring: true,
      recurringMonths: 12,
      recurringKm: 15000,
      sourceInterventionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(r.success).toBe(true);
  });
});
