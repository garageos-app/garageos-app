import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CancelInterventionSchema,
  CreateDisputeSchema,
  CreateInterventionSchema,
  PartReplacedSchema,
  UpdateInterventionSchema,
} from '../../../src/validators/intervention.js';

describe('BR-071 — PartReplacedSchema', () => {
  it('accepts a minimal valid part', () => {
    const parsed = PartReplacedSchema.parse({ name: 'Olio 5W30', quantity: 4 });
    expect(parsed.name).toBe('Olio 5W30');
    expect(parsed.code).toBeUndefined();
  });

  it('accepts a fully-specified part', () => {
    expect(() =>
      PartReplacedSchema.parse({
        name: 'Olio motore 5W30',
        code: 'SEL-5W30',
        quantity: 4.5,
        notes: 'Litri',
      }),
    ).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() => PartReplacedSchema.parse({ name: '', quantity: 1 })).toThrow();
  });

  it('rejects non-positive quantity', () => {
    expect(() => PartReplacedSchema.parse({ name: 'Bullone', quantity: 0 })).toThrow();
    expect(() => PartReplacedSchema.parse({ name: 'Bullone', quantity: -1 })).toThrow();
  });

  it('rejects name longer than 200 chars', () => {
    expect(() => PartReplacedSchema.parse({ name: 'x'.repeat(201), quantity: 1 })).toThrow();
  });
});

describe('CreateInterventionSchema', () => {
  function validInput() {
    return {
      interventionTypeId: randomUUID(),
      interventionDate: '2026-04-24',
      odometerKm: 50_000,
      description: 'Sostituzione olio motore e filtro.',
    };
  }

  it('accepts minimal valid input and fills defaults', () => {
    const parsed = CreateInterventionSchema.parse(validInput());
    expect(parsed.partsReplaced).toEqual([]);
    expect(parsed.forceKmDecrease).toBe(false);
  });

  it('accepts partsReplaced with valid shape', () => {
    const input = {
      ...validInput(),
      partsReplaced: [{ name: 'Olio 5W30', quantity: 4 }],
    };
    expect(() => CreateInterventionSchema.parse(input)).not.toThrow();
  });

  it('rejects an interventionDate not in YYYY-MM-DD', () => {
    expect(() =>
      CreateInterventionSchema.parse({ ...validInput(), interventionDate: '24/04/2026' }),
    ).toThrow();
  });

  it('rejects a negative odometerKm', () => {
    expect(() => CreateInterventionSchema.parse({ ...validInput(), odometerKm: -1 })).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => CreateInterventionSchema.parse({ ...validInput(), description: '' })).toThrow();
  });

  it('rejects description longer than 5000 chars', () => {
    expect(() =>
      CreateInterventionSchema.parse({ ...validInput(), description: 'x'.repeat(5001) }),
    ).toThrow();
  });

  it('rejects non-UUID interventionTypeId', () => {
    expect(() =>
      CreateInterventionSchema.parse({ ...validInput(), interventionTypeId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('accepts createDeadline option block', () => {
    const parsed = CreateInterventionSchema.parse({
      ...validInput(),
      createDeadline: { enabled: true, monthsFromNow: 12, kmIncrement: 15_000 },
    });
    expect(parsed.createDeadline?.enabled).toBe(true);
  });
});

describe('BR-123 / BR-124 — CreateDisputeSchema', () => {
  it.each(['not_performed', 'wrong_data', 'not_authorized', 'other'] as const)(
    'accepts reasonCategory=%s',
    (cat) => {
      expect(() =>
        CreateDisputeSchema.parse({
          reasonCategory: cat,
          description: 'a'.repeat(20),
        }),
      ).not.toThrow();
    },
  );

  it('rejects removed `overcharge` category', () => {
    expect(() =>
      CreateDisputeSchema.parse({
        reasonCategory: 'overcharge',
        description: 'a'.repeat(20),
      }),
    ).toThrow();
  });

  it('rejects description shorter than 20 chars (BR-124)', () => {
    expect(() =>
      CreateDisputeSchema.parse({
        reasonCategory: 'not_performed',
        description: 'too short',
      }),
    ).toThrow();
  });

  it('rejects description longer than 2000 chars (BR-124)', () => {
    expect(() =>
      CreateDisputeSchema.parse({
        reasonCategory: 'not_performed',
        description: 'a'.repeat(2001),
      }),
    ).toThrow();
  });

  it('accepts up to 10 attachmentIds', () => {
    expect(() =>
      CreateDisputeSchema.parse({
        reasonCategory: 'wrong_data',
        description: 'a'.repeat(20),
        attachmentIds: Array.from({ length: 10 }, () => randomUUID()),
      }),
    ).not.toThrow();
  });

  it('rejects more than 10 attachmentIds', () => {
    expect(() =>
      CreateDisputeSchema.parse({
        reasonCategory: 'wrong_data',
        description: 'a'.repeat(20),
        attachmentIds: Array.from({ length: 11 }, () => randomUUID()),
      }),
    ).toThrow();
  });
});

describe('UpdateInterventionSchema (BR-061, BR-064, BR-065)', () => {
  it('accepts a single editable field', () => {
    const parsed = UpdateInterventionSchema.parse({ description: 'Aggiornata' });
    expect(parsed.description).toBe('Aggiornata');
  });

  it('accepts all 5 editable fields plus reason', () => {
    expect(() =>
      UpdateInterventionSchema.parse({
        interventionTypeId: randomUUID(),
        title: 'Titolo nuovo',
        description: 'Descrizione',
        partsReplaced: [{ name: 'Olio', quantity: 4 }],
        internalNotes: 'Nota officina',
        reason: 'Motivazione modifica >= 10 chars',
      }),
    ).not.toThrow();
  });

  it('rejects an empty body (refine)', () => {
    expect(() => UpdateInterventionSchema.parse({})).toThrow();
  });

  it('rejects a body with only reason (no editable field)', () => {
    expect(() =>
      UpdateInterventionSchema.parse({ reason: 'Motivazione lunga abbastanza' }),
    ).toThrow();
  });

  it('rejects vehicleId in body (BR-061 immutable, strict)', () => {
    expect(() =>
      UpdateInterventionSchema.parse({
        description: 'X',
        vehicleId: randomUUID(),
      }),
    ).toThrow();
  });

  it('rejects interventionDate in body (BR-061 immutable, strict)', () => {
    expect(() =>
      UpdateInterventionSchema.parse({
        description: 'X',
        interventionDate: '2026-01-01',
      }),
    ).toThrow();
  });

  it('rejects odometerKm in body (BR-061 immutable, strict)', () => {
    expect(() =>
      UpdateInterventionSchema.parse({
        description: 'X',
        odometerKm: 100000,
      }),
    ).toThrow();
  });

  it('rejects partsReplaced not-array', () => {
    expect(() => UpdateInterventionSchema.parse({ partsReplaced: 'not an array' })).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => UpdateInterventionSchema.parse({ description: '' })).toThrow();
  });

  it('rejects reason shorter than 10 chars', () => {
    expect(() => UpdateInterventionSchema.parse({ description: 'X', reason: 'short' })).toThrow();
  });

  it('rejects reason longer than 2000 chars', () => {
    expect(() =>
      UpdateInterventionSchema.parse({
        description: 'X',
        reason: 'a'.repeat(2001),
      }),
    ).toThrow();
  });

  it('accepts title=null (BR-065 clear field)', () => {
    expect(() => UpdateInterventionSchema.parse({ title: null })).not.toThrow();
  });

  it('accepts internalNotes=null (BR-065 clear field)', () => {
    expect(() => UpdateInterventionSchema.parse({ internalNotes: null })).not.toThrow();
  });

  it('rejects description=null (NOT NULL on DB column)', () => {
    expect(() => UpdateInterventionSchema.parse({ description: null })).toThrow();
  });
});

describe('CancelInterventionSchema (BR-066)', () => {
  it('accepts a 20-char reason (boundary)', () => {
    expect(() => CancelInterventionSchema.parse({ reason: 'a'.repeat(20) })).not.toThrow();
  });

  it('accepts a 2000-char reason (boundary)', () => {
    expect(() => CancelInterventionSchema.parse({ reason: 'a'.repeat(2000) })).not.toThrow();
  });

  it('accepts a short reason (the min(20) bound is handler-side)', () => {
    // Reason BR-066: the reason_too_short error code is mapped from a
    // handler-level check, not from Zod, to expose the dedicated
    // business code. The schema only enforces `max(2000)`.
    expect(() => CancelInterventionSchema.parse({ reason: 'short' })).not.toThrow();
  });

  it('rejects a reason > 2000 chars', () => {
    expect(() => CancelInterventionSchema.parse({ reason: 'a'.repeat(2001) })).toThrow();
  });

  it('rejects extra keys (.strict())', () => {
    expect(() =>
      CancelInterventionSchema.parse({
        reason: 'Errore di trascrizione del numero di telaio.',
        cancelledByUserId: '00000000-0000-0000-0000-000000000000',
      }),
    ).toThrow();
  });

  it('rejects missing reason', () => {
    expect(() => CancelInterventionSchema.parse({})).toThrow();
  });

  it('rejects non-string reason', () => {
    expect(() => CancelInterventionSchema.parse({ reason: 42 })).toThrow();
  });
});
