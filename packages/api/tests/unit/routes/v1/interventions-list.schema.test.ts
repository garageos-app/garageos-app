import { describe, expect, it } from 'vitest';

import { interventionsListQuerySchema } from '../../../../src/routes/v1/interventions-list.schema.js';

const TYPE_ID = '55555555-5555-4555-8555-555555555501';
const TYPE_ID_2 = '66666666-6666-4666-8666-666666666601';
const CHECKLIST_ITEM_ID = '77777777-7777-4777-8777-777777777701';

describe('interventionsListQuerySchema', () => {
  it('defaults page/pageSize/status/sort/order when query is empty', () => {
    expect(interventionsListQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 25,
      status: ['active', 'disputed'],
      sort: 'date',
      order: 'desc',
    });
  });

  it('splits a comma-joined status CSV into an array', () => {
    const result = interventionsListQuerySchema.parse({ status: 'active,cancelled' });
    expect(result.status).toEqual(['active', 'cancelled']);
  });

  it('trims whitespace and drops empty tokens in a CSV param', () => {
    const result = interventionsListQuerySchema.parse({ status: ' active , , cancelled ' });
    expect(result.status).toEqual(['active', 'cancelled']);
  });

  it('rejects an invalid status token', () => {
    expect(() => interventionsListQuerySchema.parse({ status: 'bogus' })).toThrow();
  });

  it('rejects a non-UUID token in typeId', () => {
    expect(() => interventionsListQuerySchema.parse({ typeId: 'not-a-uuid' })).toThrow();
  });

  it('rejects pageSize=0', () => {
    expect(() => interventionsListQuerySchema.parse({ pageSize: 0 })).toThrow();
  });

  it('rejects pageSize=101', () => {
    expect(() => interventionsListQuerySchema.parse({ pageSize: 101 })).toThrow();
  });

  it('allows checklistItemIds when exactly one typeId is present', () => {
    const result = interventionsListQuerySchema.parse({
      checklistItemIds: CHECKLIST_ITEM_ID,
      typeId: TYPE_ID,
    });
    expect(result.checklistItemIds).toEqual([CHECKLIST_ITEM_ID]);
    expect(result.typeId).toEqual([TYPE_ID]);
  });

  it('rejects checklistItemIds when no typeId is present', () => {
    expect(() =>
      interventionsListQuerySchema.parse({ checklistItemIds: CHECKLIST_ITEM_ID }),
    ).toThrow();
  });

  it('rejects checklistItemIds when more than one typeId is present', () => {
    expect(() =>
      interventionsListQuerySchema.parse({
        checklistItemIds: CHECKLIST_ITEM_ID,
        typeId: `${TYPE_ID},${TYPE_ID_2}`,
      }),
    ).toThrow();
  });
});
