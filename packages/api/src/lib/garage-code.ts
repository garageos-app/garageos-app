import type { PrismaClient } from '@garageos/database';

// Atomic pending→certified transition with garage_code assignment.
//
// Why this exists (and why we do NOT use the plpgsql assign_garage_code()
// from migration 20260424100000:98-127): that function only UPDATEs
// `garage_code` without touching `status` / `certified_at` /
// `certified_by_tenant_id`. The two check constraints
//   chk_pending_consistency:   status='pending'   → garage_code IS NULL
//   chk_certified_consistency: status='certified' → garage_code NOT NULL
//                                                    AND certified_at NOT NULL
//                                                    AND certified_by_tenant_id NOT NULL
// make every intermediate state violate one or the other. The valid
// transition is a SINGLE UPDATE that moves all four columns atomically.
// BR-021 "3 attempts in case of collision" is still honored: we retry
// against Postgres unique-violation (SQLSTATE 23505) up to three times
// with a fresh generate_garage_code() on every attempt.
//
// See docs/APPENDICE_F_BUSINESS_LOGIC.md §2 (BR-020, BR-021, BR-022) and
// docs/APPENDICE_A_API.md §2.1 "Note di implementazione".

const MAX_ATTEMPTS = 3;
const UNIQUE_VIOLATION_SQLSTATE = '23505';

export class GarageCodeAssignmentError extends Error {
  constructor(public readonly attempts: number) {
    super(`Could not generate a unique garage_code after ${attempts} attempts`);
    this.name = 'GarageCodeAssignmentError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE
  );
}

export async function certifyVehicleWithGarageCode(
  tx: PrismaClient,
  vehicleId: string,
  tenantId: string,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = (await tx.$queryRawUnsafe('SELECT generate_garage_code() AS code')) as Array<{
      code: string;
    }>;
    const candidate = rows[0]!.code;

    try {
      await tx.$executeRawUnsafe(
        `UPDATE vehicles
         SET garage_code = $1,
             status = 'certified',
             certified_at = NOW(),
             certified_by_tenant_id = $2
         WHERE id = $3 AND garage_code IS NULL`,
        candidate,
        tenantId,
        vehicleId,
      );
      return candidate;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new GarageCodeAssignmentError(MAX_ATTEMPTS);
}
