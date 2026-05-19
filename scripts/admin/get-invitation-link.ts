#!/usr/bin/env node
/**
 * Operator-only: fetch the magic-link URL for a pending F-OFF-004 invitation.
 *
 * Use when SES sandbox/limbo prevents the invitation email from being
 * delivered. The operator runs the script with DIRECT_URL set and
 * delivers the resulting URL to the invitee out-of-band.
 *
 * Usage:
 *   pnpm tsx scripts/admin/get-invitation-link.ts <email> [--tenant <tenantId>]
 *
 * Exit codes:
 *   0 — success, URL printed
 *   1 — no pending invitation / arg missing
 *   2 — multiple matches (tenant filter required)
 *   3 — DIRECT_URL missing or DB error
 */

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@garageos/database';

const DEFAULT_BASE = 'https://app.garageos.aifollyadvisor.com';

async function main() {
  const args = process.argv.slice(2);
  const email = args[0];
  const tenantIdx = args.indexOf('--tenant');
  const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;

  if (!email) {
    console.error(
      'Usage: pnpm tsx scripts/admin/get-invitation-link.ts <email> [--tenant <tenantId>]',
    );
    process.exit(1);
  }
  if (!process.env.DIRECT_URL) {
    console.error('DIRECT_URL env var required.');
    process.exit(3);
  }

  const baseUrl = process.env.WEB_BASE_URL ?? DEFAULT_BASE;
  const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const invitations = await prisma.invitation.findMany({
      where: {
        invitationType: 'internal_user',
        targetEmail: email.trim().toLowerCase(),
        acceptedAt: null,
        expiresAt: { gt: new Date() },
        ...(tenantId ? { tenantId } : {}),
      },
      select: { id: true, token: true, tenantId: true, expiresAt: true },
    });

    if (invitations.length === 0) {
      console.error(
        `No pending invitation found for ${email}` + (tenantId ? ` in tenant ${tenantId}` : ''),
      );
      process.exit(1);
    }
    if (invitations.length > 1) {
      console.error(
        `Multiple pending invitations across tenants. Use --tenant <tenantId>. Candidates:`,
      );
      for (const i of invitations) {
        console.error(`  tenant ${i.tenantId} — expires ${i.expiresAt.toISOString()}`);
      }
      process.exit(2);
    }

    const inv = invitations[0]!;
    console.log(`${baseUrl}/invitations/${inv.token}`);
    process.exit(0);
  } catch (err) {
    console.error('DB error:', err instanceof Error ? err.message : err);
    process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
