import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DeadlineDashboard } from './DeadlineDashboard';
import type {
  DeadlinesListResponse,
  InterventionTypesResponse,
  TenantDeadline,
} from '@/queries/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

// Radix Select uses pointer-capture APIs not available in JSDOM; replace with
// a plain <select> so the dropdown test can interact without polyfilling.
// The stub renders a single native <select role="combobox"> that contains all
// SelectItem children; SelectTrigger/SelectValue/SelectContent are no-ops.
vi.mock('@/components/ui/select', async () => {
  const { createContext, useContext, useState, useEffect } =
    await vi.importActual<typeof import('react')>('react');

  type SelectCtx = {
    value?: string;
    onValueChange?: (v: string) => void;
    setOptions: (opts: import('react').ReactNode) => void;
  };
  const Ctx = createContext<SelectCtx>({ setOptions: () => {} });

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: import('react').ReactNode;
  }) {
    const [options, setOptions] = useState<import('react').ReactNode>(null);
    return (
      <Ctx.Provider value={{ value, onValueChange, setOptions }}>
        <div style={{ display: 'none' }}>{children}</div>
        <select
          role="combobox"
          value={value ?? ''}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          {options}
        </select>
      </Ctx.Provider>
    );
  }

  function SelectTrigger({
    children,
  }: {
    children?: import('react').ReactNode;
    className?: string;
  }) {
    return <span>{children}</span>;
  }

  function SelectValue({ placeholder }: { placeholder?: string }) {
    return <span>{placeholder}</span>;
  }

  function SelectContent({ children }: { children?: import('react').ReactNode }) {
    const { setOptions } = useContext(Ctx);
    useEffect(() => {
      setOptions(children);
    });
    return null;
  }

  function SelectItem({
    value,
    children,
  }: {
    value: string;
    children?: import('react').ReactNode;
  }) {
    return <option value={value}>{children}</option>;
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const TODAY_OFFSET_DAYS = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
};

function makeDeadline(id: string, dueOffsetDays: number): TenantDeadline {
  return {
    id,
    vehicleId: `veh-${id}`,
    interventionTypeId: 't1',
    dueDate: TODAY_OFFSET_DAYS(dueOffsetDays),
    dueOdometerKm: null,
    description: null,
    isRecurring: false,
    status: 'open',
    vehicle: {
      id: `veh-${id}`,
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: {
        customer: {
          id: 'cust-1',
          firstName: 'Mario',
          lastName: 'Rossi',
          email: 'mario@example.it',
          phone: null,
          isBusiness: false,
          businessName: null,
          vatNumber: null,
        },
      },
    },
    interventionType: { id: 't1', code: 'TAGLIANDO', nameIt: 'Tagliando' },
  };
}

const TYPES_FIXTURE: InterventionTypesResponse = {
  data: [
    {
      id: 't1',
      code: 'TAGLIANDO',
      nameIt: 'Tagliando',
      description: '',
      icon: 'wrench',
      suggestsDeadline: true,
      defaultDeadlineMonths: 12,
      defaultDeadlineKm: 15000,
      custom: false,
      checklistItems: [],
    },
    {
      id: 't2',
      code: 'GOMME',
      nameIt: 'Gomme',
      description: '',
      icon: 'circle',
      suggestsDeadline: false,
      defaultDeadlineMonths: null,
      defaultDeadlineKm: null,
      custom: false,
      checklistItems: [],
    },
  ],
};

function setupApiFetch(deadlinesResp: DeadlinesListResponse | Error) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === '/v1/intervention-types') return TYPES_FIXTURE;
    if (path.startsWith('/v1/deadlines')) {
      if (deadlinesResp instanceof Error) throw deadlinesResp;
      return deadlinesResp;
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

describe('DeadlineDashboard', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });
  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows skeletons while data is loading', () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}));
    render(wrap({ children: <DeadlineDashboard /> }));
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows error alert with Riprova on failure', async () => {
    setupApiFetch(new Error('boom'));
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument(),
    );
  });

  it('renders all 4 grouping sections with counts', async () => {
    setupApiFetch({
      deadlines: [
        makeDeadline('overdue1', -10),
        makeDeadline('week1', 3),
        makeDeadline('month1', 20),
        makeDeadline('three1', 60),
      ],
      nextCursor: null,
    });
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() => expect(screen.getByText(/Scadute/i)).toBeInTheDocument());
    expect(screen.getByText(/Questa settimana/i)).toBeInTheDocument();
    expect(screen.getByText(/Questo mese/i)).toBeInTheDocument();
    expect(screen.getByText(/Prossimi 3 mesi/i)).toBeInTheDocument();
  });

  it('shows empty-state when no deadlines exist', async () => {
    setupApiFetch({ deadlines: [], nextCursor: null });
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() =>
      expect(screen.getByText(/nessuna scadenza configurata/i)).toBeInTheDocument(),
    );
  });

  it('refetches with intervention_type_id when the dropdown changes', async () => {
    setupApiFetch({ deadlines: [], nextCursor: null });
    const user = userEvent.setup();
    render(wrap({ children: <DeadlineDashboard /> }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const initialCalls = apiFetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('/v1/deadlines'),
    ).length;

    // Wait for types data to populate the options before selecting.
    const trigger = screen.getByRole('combobox');
    await waitFor(() => expect(trigger.querySelector('option[value="t1"]')).not.toBeNull());

    // Select is stubbed as a native <select role="combobox"> so we can use
    // selectOptions directly without Radix pointer-capture polyfills.
    await user.selectOptions(trigger, 't1');

    await waitFor(() => {
      const filtered = apiFetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('intervention_type_id=t1'),
      );
      expect(filtered.length).toBeGreaterThan(0);
    });
    // sanity: total deadlines calls increased
    const finalCalls = apiFetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('/v1/deadlines'),
    ).length;
    expect(finalCalls).toBeGreaterThan(initialCalls);
  });

  it('shows "Carica altre" when hasNextPage', async () => {
    setupApiFetch({
      deadlines: [makeDeadline('d1', 5)],
      nextCursor: 'next-cursor-id',
    });
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /carica altre/i })).toBeInTheDocument(),
    );
  });
});
