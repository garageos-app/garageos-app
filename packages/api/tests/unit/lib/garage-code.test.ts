import { describe, expect, it, vi } from 'vitest';

import {
  certifyVehicleWithGarageCode,
  GarageCodeAssignmentError,
} from '../../../src/lib/garage-code.js';

interface FakeTx {
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
}

function buildFakeTx(codes: string[], executeResults: Array<number | Error>): FakeTx {
  const code = [...codes];
  const exec = [...executeResults];
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      // generate_garage_code() returns a single-column row.
      if (sql.includes('generate_garage_code')) {
        const next = code.shift();
        if (!next) throw new Error('ran out of fake codes');
        return [{ code: next }];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    $executeRawUnsafe: vi.fn(async () => {
      const next = exec.shift();
      if (next === undefined) throw new Error('ran out of fake exec results');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

function uniqueViolation(): Error {
  // Prisma surfaces raw SQL errors as thrown with .code on the error
  // when using $executeRawUnsafe + the pg adapter. We mimic that shape.
  const err = new Error('duplicate key value violates unique constraint') as Error & {
    code?: string;
  };
  err.code = '23505';
  return err;
}

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('certifyVehicleWithGarageCode', () => {
  it('returns the assigned code on first try when no collision', async () => {
    const tx = buildFakeTx(['GO-234-ABCD'], [1]);
    const code = await certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID);
    expect(code).toBe('GO-234-ABCD');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('retries on 23505 unique_violation and succeeds on attempt 2', async () => {
    const tx = buildFakeTx(['GO-234-ABCD', 'GO-567-EFGH'], [uniqueViolation(), 1]);
    const code = await certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID);
    expect(code).toBe('GO-567-EFGH');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('throws GarageCodeAssignmentError after 3 consecutive collisions', async () => {
    const tx = buildFakeTx(
      ['GO-234-ABCD', 'GO-567-EFGH', 'GO-891-JKLM'],
      [uniqueViolation(), uniqueViolation(), uniqueViolation()],
    );
    await expect(
      certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(GarageCodeAssignmentError);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it('propagates non-23505 errors without retrying', async () => {
    const otherError = new Error('connection reset');
    const tx = buildFakeTx(['GO-234-ABCD'], [otherError]);
    await expect(certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID)).rejects.toBe(
      otherError,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
