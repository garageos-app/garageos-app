import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InterventionsFilterBar, type InterventionFilterValues } from './InterventionsFilterBar';

const useInterventionTypesMock = vi.fn();
const useUsersMock = vi.fn();
const useHasRoleMock = vi.fn();

vi.mock('@/queries/interventionTypes', () => ({
  useInterventionTypes: () => useInterventionTypesMock(),
}));
vi.mock('@/queries/users-admin', () => ({
  useUsers: () => useUsersMock(),
}));
vi.mock('@/auth/useHasRole', () => ({
  useHasRole: (role: string) => useHasRoleMock(role),
}));

const TYPES = {
  data: {
    data: [
      {
        id: 't1',
        code: 'MECCANICO',
        nameIt: 'Intervento Meccanico',
        description: '',
        icon: '',
        suggestsDeadline: false,
        defaultDeadlineMonths: null,
        defaultDeadlineKm: null,
        custom: false,
        checklistItems: [
          { id: 'c1', code: 'OLIO', nameIt: 'Cambio olio', sortOrder: 1 },
          { id: 'c2', code: 'FILTRO', nameIt: 'Filtro', sortOrder: 2 },
        ],
      },
      {
        id: 't2',
        code: 'GOMME',
        nameIt: 'Cambio Gomme',
        description: '',
        icon: '',
        suggestsDeadline: false,
        defaultDeadlineMonths: null,
        defaultDeadlineKm: null,
        custom: false,
        checklistItems: [{ id: 'c3', code: 'PNEU', nameIt: 'Pneumatici', sortOrder: 1 }],
      },
    ],
  },
  isPending: false,
};

const EMPTY_VALUES: InterventionFilterValues = {
  q: '',
  status: [],
  typeId: [],
  checklistItemIds: [],
  operatorId: [],
  dateFrom: '',
  dateTo: '',
};

function renderBar(values: Partial<InterventionFilterValues>, onChange = vi.fn()) {
  render(<InterventionsFilterBar values={{ ...EMPTY_VALUES, ...values }} onChange={onChange} />);
  return onChange;
}

describe('InterventionsFilterBar', () => {
  beforeEach(() => {
    useInterventionTypesMock.mockReturnValue(TYPES);
    useUsersMock.mockReturnValue({ data: { users: [] }, isPending: false });
    useHasRoleMock.mockReturnValue(false);
  });

  it('hides the Voci control when no type is selected', () => {
    renderBar({ typeId: [] });
    expect(screen.queryByRole('button', { name: /voci/i })).not.toBeInTheDocument();
  });

  it('shows the Voci control when exactly one type is selected', () => {
    renderBar({ typeId: ['t1'] });
    expect(screen.getByRole('button', { name: /voci/i })).toBeInTheDocument();
  });

  it('hides the Voci control when two types are selected', () => {
    renderBar({ typeId: ['t1', 't2'] });
    expect(screen.queryByRole('button', { name: /voci/i })).not.toBeInTheDocument();
  });

  it('hides the Operatore filter for non-super-admins', () => {
    useHasRoleMock.mockReturnValue(false);
    renderBar({});
    expect(screen.queryByRole('button', { name: /operatore/i })).not.toBeInTheDocument();
  });

  it('shows the Operatore filter for super-admins', () => {
    useHasRoleMock.mockReturnValue(true);
    useUsersMock.mockReturnValue({
      data: {
        users: [
          {
            id: 'u1',
            email: 'mario@x.it',
            firstName: 'Mario',
            lastName: 'Rossi',
            role: 'mechanic',
            status: 'active',
            createdAt: '',
            deletedAt: null,
          },
        ],
      },
      isPending: false,
    });
    renderBar({});
    expect(screen.getByRole('button', { name: /operatore/i })).toBeInTheDocument();
  });

  it('clears checklistItemIds when the type selection changes', async () => {
    const onChange = renderBar({ typeId: ['t1'], checklistItemIds: ['c1'] });
    await userEvent.click(screen.getByRole('button', { name: /tipo/i }));
    // Selecting a second type must reset the checklist filter.
    await userEvent.click(screen.getByText('Cambio Gomme'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ checklistItemIds: [] }));
  });
});
