import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertInterventionTypeExists,
  assertNotFutureInterventionDate,
  validateChecklistSelection,
} from '../../../src/lib/intervention-shared.js';

describe('assertNotFutureInterventionDate', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the parsed UTC Date when the input is in the past', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-13T10:00:00.000Z'));
    const result = assertNotFutureInterventionDate('2026-05-12', 'x.code', 'x msg');
    expect(result.toISOString()).toBe('2026-05-12T00:00:00.000Z');
  });

  it('returns the parsed UTC Date when the input is today', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-13T10:00:00.000Z'));
    const result = assertNotFutureInterventionDate('2026-05-13', 'x.code', 'x msg');
    expect(result.toISOString()).toBe('2026-05-13T00:00:00.000Z');
  });

  it('throws a 422 businessError with the supplied code+message on a future date', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-13T10:00:00.000Z'));
    expect(() =>
      assertNotFutureInterventionDate(
        '2026-05-14',
        'private_intervention.date_future',
        'Non è possibile registrare interventi futuri.',
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'private_intervention.date_future',
        statusCode: 422,
        message: 'Non è possibile registrare interventi futuri.',
      }),
    );
  });
});

describe('assertInterventionTypeExists', () => {
  it('resolves silently when the type exists', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'type-1' });
    const tx = { interventionType: { findFirst } } as unknown as Parameters<
      typeof assertInterventionTypeExists
    >[0];
    await expect(assertInterventionTypeExists(tx, 'type-1')).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'type-1' },
      select: { id: true },
    });
  });

  it('throws VALIDATION_ERROR 422 when the type does not exist', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = { interventionType: { findFirst } } as unknown as Parameters<
      typeof assertInterventionTypeExists
    >[0];
    await expect(assertInterventionTypeExists(tx, 'missing-id')).rejects.toMatchObject({
      name: 'VALIDATION_ERROR',
      statusCode: 422,
      message: 'Tipo intervento non valido.',
    });
  });
});

describe('validateChecklistSelection', () => {
  // Task 2 (customer/private intervention path, Tasks 5-6): the customer
  // path has no tenant, so it calls this validator without `tenantId` and
  // must skip the two BR-302/304 tenant-exclusion queries entirely — the
  // officina path (interventions.ts / interventions-update.ts) still passes
  // `tenantId` and must behave exactly as before (covered by the existing
  // route-level unit/integration tests, unchanged by this task).
  it('skips tenant-exclusion checks when tenantId is omitted (customer path)', async () => {
    const typeExclusionFindFirst = vi.fn(() => {
      throw new Error('must not query exclusions');
    });
    const itemExclusionFindMany = vi.fn(() => {
      throw new Error('must not query exclusions');
    });
    const found = vi.fn().mockResolvedValue([{ id: 'a', nameIt: 'Olio', sortOrder: 0 }]);
    const tx = {
      tenantInterventionTypeExclusion: { findFirst: typeExclusionFindFirst },
      tenantChecklistItemExclusion: { findMany: itemExclusionFindMany },
      interventionChecklistItem: { findMany: found },
    } as unknown as Parameters<typeof validateChecklistSelection>[0];

    const result = await validateChecklistSelection(tx, {
      interventionTypeId: 't1',
      checklistItemIds: ['a'],
    });

    expect(result).toEqual([{ id: 'a', nameIt: 'Olio', sortOrder: 0 }]);
    expect(typeExclusionFindFirst).not.toHaveBeenCalled();
    expect(itemExclusionFindMany).not.toHaveBeenCalled();
  });

  it('still rejects an empty checklist without tenantId (BR-300)', async () => {
    const tx = {
      interventionChecklistItem: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Parameters<typeof validateChecklistSelection>[0];

    await expect(
      validateChecklistSelection(tx, { interventionTypeId: 't1', checklistItemIds: [] }),
    ).rejects.toMatchObject({
      name: 'intervention.creation.checklist_required',
      statusCode: 400,
      message: 'Seleziona almeno una voce checklist.',
    });
  });
});
