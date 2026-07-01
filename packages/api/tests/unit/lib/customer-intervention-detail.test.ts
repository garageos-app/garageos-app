import { describe, expect, it } from 'vitest';

import {
  projectShopInterventionDetail,
  type RawInterventionRow,
  type RawDisputeRow,
} from '../../../src/lib/customer-intervention-detail.js';

const baseRow: RawInterventionRow = {
  id: 'int-1',
  vehicleId: 'veh-1',
  interventionDate: new Date('2026-05-01T00:00:00.000Z'),
  odometerKm: 84210,
  title: 'Tagliando completo',
  description: 'Sostituzione olio e filtri',
  partsReplaced: [{ name: 'Olio' }, { name: 'Filtro' }, { name: 'Candele' }],
  status: 'disputed',
  interventionType: { code: 'TAGLIANDO', nameIt: 'Tagliando' },
  tenant: { businessName: 'Officina Rossi' },
  sourceDeadlines: [],
};

describe('projectShopInterventionDetail', () => {
  it('serializes intervention with date-only interventionDate and derived counts', () => {
    const out = projectShopInterventionDetail(baseRow, []);
    expect(out.intervention).toEqual({
      id: 'int-1',
      vehicleId: 'veh-1',
      interventionDate: '2026-05-01',
      odometerKm: 84210,
      type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
      title: 'Tagliando completo',
      description: 'Sostituzione olio e filtri',
      partsReplaced: [
        { name: 'Olio', code: null, quantity: 1, notes: null },
        { name: 'Filtro', code: null, quantity: 1, notes: null },
        { name: 'Candele', code: null, quantity: 1, notes: null },
      ],
      partsReplacedCount: 3,
      status: 'disputed',
      isDisputed: true,
      tenant: { businessName: 'Officina Rossi' },
      generatedDeadlines: [],
    });
    expect(out.disputes).toEqual([]);
  });

  it('maps generated deadlines with date-only dueDate and snake-case type', () => {
    const out = projectShopInterventionDetail(
      {
        ...baseRow,
        sourceDeadlines: [
          {
            id: 'dl-1',
            dueDate: new Date('2027-05-15T00:00:00.000Z'),
            dueOdometerKm: 120000,
            description: 'Prossima revisione',
            status: 'open',
            interventionType: { code: 'REVISIONE', nameIt: 'Revisione' },
          },
          {
            id: 'dl-2',
            dueDate: null,
            dueOdometerKm: 150000,
            description: null,
            status: 'overdue',
            interventionType: { code: 'TAGLIANDO', nameIt: 'Tagliando' },
          },
        ],
      },
      [],
    );
    expect(out.intervention.generatedDeadlines).toEqual([
      {
        id: 'dl-1',
        type: { code: 'REVISIONE', name_it: 'Revisione' },
        dueDate: '2027-05-15',
        dueOdometerKm: 120000,
        description: 'Prossima revisione',
        status: 'open',
      },
      {
        id: 'dl-2',
        type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
        dueDate: null,
        dueOdometerKm: 150000,
        description: null,
        status: 'overdue',
      },
    ]);
  });

  it('normalizes full part records (code, quantity, notes preserved)', () => {
    const out = projectShopInterventionDetail(
      {
        ...baseRow,
        partsReplaced: [{ name: 'Pastiglie', code: 'BRK-42', quantity: 4, notes: 'Anteriori' }],
      },
      [],
    );
    expect(out.intervention.partsReplaced).toEqual([
      { name: 'Pastiglie', code: 'BRK-42', quantity: 4, notes: 'Anteriori' },
    ]);
    expect(out.intervention.partsReplacedCount).toBe(1);
  });

  it('maps the dispute thread and exposes the tenant response', () => {
    const disputeRow: RawDisputeRow = {
      id: 'd-1',
      reasonCategory: 'wrong_data',
      customerDescription: 'I km riportati sono errati',
      status: 'responded',
      createdAt: new Date('2026-05-02T10:00:00.000Z'),
      tenantResponse: 'Abbiamo verificato il valore',
      tenantResponseAt: new Date('2026-05-03T09:00:00.000Z'),
      resolvedAt: null,
    };
    const out = projectShopInterventionDetail({ ...baseRow, status: 'disputed' }, [disputeRow]);
    expect(out.disputes).toEqual([
      {
        id: 'd-1',
        reasonCategory: 'wrong_data',
        customerDescription: 'I km riportati sono errati',
        status: 'responded',
        createdAt: '2026-05-02T10:00:00.000Z',
        tenantResponse: 'Abbiamo verificato il valore',
        tenantResponseAt: '2026-05-03T09:00:00.000Z',
        resolvedAt: null,
      },
    ]);
  });

  it('handles null title and non-array partsReplaced defensively', () => {
    const out = projectShopInterventionDetail(
      { ...baseRow, title: null, partsReplaced: null as unknown as unknown[], status: 'active' },
      [],
    );
    expect(out.intervention.title).toBeNull();
    expect(out.intervention.partsReplacedCount).toBe(0);
    expect(out.intervention.isDisputed).toBe(false);
  });
});
