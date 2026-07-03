import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CancelInterventionSchema,
  CreateDisputeSchema,
  CreateInterventionSchema,
  PartReplacedSchema,
  RespondToDisputeSchema,
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
      checklistItemIds: [] as string[],
    };
  }

  it('accepts minimal valid input and fills defaults', () => {
    const parsed = CreateInterventionSchema.parse(validInput());
    expect(parsed.partsReplaced).toEqual([]);
    expect(parsed.forceKmDecrease).toBe(false);
    expect(parsed.checklistItemIds).toEqual([]);
  });

  it('accepts checklistItemIds as an empty array (BR-300 "at least 1" is handler-side)', () => {
    const parsed = CreateInterventionSchema.parse({ ...validInput(), checklistItemIds: [] });
    expect(parsed.checklistItemIds).toEqual([]);
  });

  it('accepts checklistItemIds with a valid uuid', () => {
    const itemId = randomUUID();
    const parsed = CreateInterventionSchema.parse({
      ...validInput(),
      checklistItemIds: [itemId],
    });
    expect(parsed.checklistItemIds).toEqual([itemId]);
  });

  it('rejects a missing checklistItemIds (required field)', () => {
    const input: Partial<ReturnType<typeof validInput>> = validInput();
    delete input.checklistItemIds;
    expect(() => CreateInterventionSchema.parse(input)).toThrow();
  });

  it('rejects checklistItemIds containing a non-uuid entry', () => {
    expect(() =>
      CreateInterventionSchema.parse({ ...validInput(), checklistItemIds: ['not-a-uuid'] }),
    ).toThrow();
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
});

describe('UpdateInterventionSchema (BR-061, BR-064, BR-065)', () => {
  it('accepts a single editable field', () => {
    const parsed = UpdateInterventionSchema.parse({ description: 'Aggiornata' });
    expect(parsed.description).toBe('Aggiornata');
  });

  it('accepts all editable fields plus reason', () => {
    expect(() =>
      UpdateInterventionSchema.parse({
        interventionTypeId: randomUUID(),
        description: 'Descrizione',
        partsReplaced: [{ name: 'Olio', quantity: 4 }],
        internalNotes: 'Nota officina',
        checklistItemIds: [randomUUID()],
        reason: 'Motivazione modifica >= 10 chars',
      }),
    ).not.toThrow();
  });

  it('accepts a body with only checklistItemIds (refine satisfied)', () => {
    const parsed = UpdateInterventionSchema.parse({ checklistItemIds: [randomUUID()] });
    expect(parsed.checklistItemIds).toHaveLength(1);
  });

  it('rejects checklistItemIds containing a non-uuid entry', () => {
    expect(() => UpdateInterventionSchema.parse({ checklistItemIds: ['not-a-uuid'] })).toThrow();
  });

  it('rejects title in body (removed field, .strict())', () => {
    expect(() =>
      UpdateInterventionSchema.parse({ description: 'X', title: 'Titolo nuovo' }),
    ).toThrow();
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

describe('RespondToDisputeSchema (BR-129)', () => {
  it('accepts a 20-char tenantResponse (boundary)', () => {
    expect(() => RespondToDisputeSchema.parse({ tenantResponse: 'a'.repeat(20) })).not.toThrow();
  });

  it('accepts a 2000-char tenantResponse (boundary)', () => {
    expect(() => RespondToDisputeSchema.parse({ tenantResponse: 'a'.repeat(2000) })).not.toThrow();
  });

  it('accepts a short tenantResponse (the min(20) bound is handler-side)', () => {
    // BR-129: the description_too_short error code is emitted by the
    // route handler, not Zod, to expose the dedicated business code.
    // The schema only enforces `max(2000)`.
    expect(() => RespondToDisputeSchema.parse({ tenantResponse: 'short' })).not.toThrow();
  });

  it('rejects a tenantResponse > 2000 chars', () => {
    expect(() => RespondToDisputeSchema.parse({ tenantResponse: 'a'.repeat(2001) })).toThrow();
  });

  it('accepts an optional disputeId UUID', () => {
    expect(() =>
      RespondToDisputeSchema.parse({
        tenantResponse: 'a'.repeat(20),
        disputeId: '11111111-1111-4111-8111-111111111111',
      }),
    ).not.toThrow();
  });

  it('rejects an invalid disputeId (non-UUID)', () => {
    expect(() =>
      RespondToDisputeSchema.parse({
        tenantResponse: 'a'.repeat(20),
        disputeId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('rejects extra keys (.strict())', () => {
    expect(() =>
      RespondToDisputeSchema.parse({
        tenantResponse: 'a'.repeat(20),
        respondedByUserId: '00000000-0000-0000-0000-000000000000',
      }),
    ).toThrow();
  });

  it('rejects missing tenantResponse', () => {
    expect(() => RespondToDisputeSchema.parse({})).toThrow();
  });

  it('rejects non-string tenantResponse', () => {
    expect(() => RespondToDisputeSchema.parse({ tenantResponse: 42 })).toThrow();
  });
});
