import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// VIN: 11 fixed prefix chars + 6-digit zero-padded sequence = 17 chars.
// Satisfies BR-001 regex (no I/O/Q) because the prefix uses only safe chars
// and the suffix is digits. Good for ~1M unique sequences per test run.
function sequenceVin(seq: number): string {
  return `ZFA16900000${String(seq).padStart(6, '0')}`;
}

// Italian plate: 2 letters + 3 digits + 2 letters. Cycle through 1000 digit
// slots; suffix letters rotate every 1000 to extend uniqueness beyond that.
function sequencePlate(seq: number): string {
  const suffixIdx = Math.floor((seq - 1) / 1000) % 26;
  const suffix = String.fromCharCode(65 + suffixIdx); // A..Z
  const digits = String((seq - 1) % 1000).padStart(3, '0');
  return `AB${digits}${suffix}${suffix}`;
}

export const VehicleFactory = Factory.define<Prisma.VehicleUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.vehicle.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      garageCode: null, // BR-003 — pending vehicles have no code yet
      vin: sequenceVin(sequence),
      plate: sequencePlate(sequence),
      plateCountry: 'IT',
      make: 'Fiat',
      model: 'Panda',
      year: 2021,
      vehicleType: 'car',
      fuelType: 'petrol',
      status: 'pending',
    };
  },
);

// BR-004/020/021 — certified vehicles have a certifying tenant and a
// garage_code. Deterministic code derived from sequence so fixtures are
// reproducible; the real production generator is a crypto-random retry loop.
// BR-020 regex is authoritative: [A-HJ-NPRTV-Z] excludes I, O, Q, S, U
// — 21 allowed letters (the doc text saying "22" is imprecise; the regex
// is what the schema enforces). Digits: 2-9, i.e. 8 allowed.
const DIGITS = '23456789';
const LETTERS = 'ABCDEFGHJKLMNPRTVWXYZ';
function sequenceGarageCode(seq: number): string {
  const d = [
    DIGITS[Math.floor(seq / 64) % 8],
    DIGITS[Math.floor(seq / 8) % 8],
    DIGITS[seq % 8],
  ].join('');
  const n = LETTERS.length;
  const l = [
    LETTERS[Math.floor(seq / (n * n * n)) % n],
    LETTERS[Math.floor(seq / (n * n)) % n],
    LETTERS[Math.floor(seq / n) % n],
    LETTERS[seq % n],
  ].join('');
  return `GO-${d}-${l}`;
}

export const certifiedVehicle = VehicleFactory.params({ status: 'certified' });

// Helper to mint a deterministic valid garage_code from a sequence — exported
// for test use where callers need to pair a factory-built vehicle with a
// matching code.
export function buildGarageCode(seq: number): string {
  return sequenceGarageCode(seq);
}

export const motorcycle = VehicleFactory.params({ vehicleType: 'motorcycle' });
