import { describe, expect, it, vi } from 'vitest';

import {
  certifyVehicleWithGarageCode,
  GarageCodeAssignmentError,
  VehicleNotCertifiableError,
} from '../../../src/lib/garage-code.js';

interface FakeTx {
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
}

function buildFakeTx(codes: string[], executeResults: Array<number | Error>): FakeTx {
  const code = [...codes];
  const exec = [...executeResults];
  return {
    // Prisma's tagged-template `$queryRaw` is invoked as a tagged template:
    // tx.$queryRaw`SELECT ...`. At runtime the first arg is the
    // TemplateStringsArray; subsequent args are the interpolated values.
    // We inspect the raw SQL strings to dispatch, which lets the same fake
    // cover every query issued by the helper.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('generate_garage_code')) {
        const next = code.shift();
        if (!next) throw new Error('ran out of fake codes');
        return [{ code: next }];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    $executeRaw: vi.fn(async () => {
      const next = exec.shift();
      if (next === undefined) throw new Error('ran out of fake exec results');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

function uniqueViolation(): Error {
  // Prisma surfaces raw SQL errors as thrown with .code on the error
  // when using $executeRaw + the pg adapter. We mimic that shape.
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
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('retries on 23505 unique_violation and succeeds on attempt 2', async () => {
    const tx = buildFakeTx(['GO-234-ABCD', 'GO-567-EFGH'], [uniqueViolation(), 1]);
    const code = await certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID);
    expect(code).toBe('GO-567-EFGH');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('throws GarageCodeAssignmentError after 3 consecutive collisions', async () => {
    const tx = buildFakeTx(
      ['GO-234-ABCD', 'GO-567-EFGH', 'GO-891-JKLM'],
      [uniqueViolation(), uniqueViolation(), uniqueViolation()],
    );
    await expect(
      certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(GarageCodeAssignmentError);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('propagates non-23505 errors without retrying', async () => {
    const otherError = new Error('connection reset');
    const tx = buildFakeTx(['GO-234-ABCD'], [otherError]);
    await expect(certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID)).rejects.toBe(
      otherError,
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('throws VehicleNotCertifiableError when the UPDATE affects 0 rows (no retry)', async () => {
    // 0 rows affected means the vehicle is no longer in a certifiable state
    // (gone, already certified by a concurrent writer, etc.). A fresh
    // candidate code cannot help — this MUST NOT retry.
    const tx = buildFakeTx(['GO-234-ABCD'], [0]);
    await expect(
      certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(VehicleNotCertifiableError);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('throws a generic Error when the UPDATE affects more than 1 row (defensive)', async () => {
    // Impossible given the PK-equal WHERE clause, but we guard anyway so a
    // schema regression (e.g. duplicate PKs) surfaces loudly instead of
    // silently returning a code associated with multiple rows.
    const tx = buildFakeTx(['GO-234-ABCD'], [2]);
    await expect(certifyVehicleWithGarageCode(tx as never, VEHICLE_ID, TENANT_ID)).rejects.toThrow(
      /expected 1/,
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
