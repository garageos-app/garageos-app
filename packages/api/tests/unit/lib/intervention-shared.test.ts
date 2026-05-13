import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertNotFutureInterventionDate } from '../../../src/lib/intervention-shared.js';

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
