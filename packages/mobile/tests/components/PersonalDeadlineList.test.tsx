import { render, screen } from '@testing-library/react-native';
import { ApiError } from '@/lib/api-error';
import type { PersonalDeadlineDto } from '@/lib/types/personalDeadline';

// expo-router is consumed via useRouter (FAB + row navigation). The list does
// not read params, so a bare push mock is enough.
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const mockUsePersonalDeadlines = jest.fn();
jest.mock('@/queries/personalDeadlines', () => ({
  usePersonalDeadlines: () => mockUsePersonalDeadlines(),
}));

import { PersonalDeadlineList } from '@/components/PersonalDeadlineList';

function deadline(overrides: Partial<PersonalDeadlineDto>): PersonalDeadlineDto {
  return {
    id: 'pd-1',
    vehicleId: 'veh-1',
    vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
    category: 'insurance',
    dueDate: '2099-01-01',
    reminderLeadDays: [7],
    notifyPush: true,
    notifyEmail: false,
    status: 'open',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// Anchor relative-date buckets against a fixed "today" so the fixture lands in
// deterministic urgency sections regardless of when the suite runs.
const TODAY = new Date('2026-06-16T10:00:00.000Z');

describe('PersonalDeadlineList', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(TODAY);
    mockUsePersonalDeadlines.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('groups deadlines into urgency sections and renders category labels', () => {
    mockUsePersonalDeadlines.mockReturnValue({
      data: [
        deadline({ id: 'a', category: 'insurance', status: 'overdue', dueDate: '2026-06-01' }),
        deadline({ id: 'b', category: 'road_tax', dueDate: '2026-06-18' }), // this week
        deadline({ id: 'c', category: 'inspection', dueDate: '2026-07-05' }), // this month
        deadline({ id: 'd', category: 'service', dueDate: '2026-12-01' }), // later
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<PersonalDeadlineList />);

    // Section titles for every non-empty bucket.
    expect(screen.getByText('Scadute')).toBeOnTheScreen();
    expect(screen.getByText('Questa settimana')).toBeOnTheScreen();
    expect(screen.getByText('Questo mese')).toBeOnTheScreen();
    expect(screen.getByText('Oltre')).toBeOnTheScreen();

    // A representative category label is rendered in a row.
    expect(screen.getByText('Assicurazione')).toBeOnTheScreen();
    expect(screen.getByText('Bollo')).toBeOnTheScreen();
  });

  it('renders the error state with the mapped message', () => {
    mockUsePersonalDeadlines.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError('personal_deadline.not_found', 404, 'nope'),
      refetch: jest.fn(),
    });

    render(<PersonalDeadlineList />);

    expect(screen.getByText('Scadenza non trovata.')).toBeOnTheScreen();
  });

  it('renders the empty state when there are no deadlines', () => {
    mockUsePersonalDeadlines.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<PersonalDeadlineList />);

    expect(screen.getByText('Nessuna scadenza personale')).toBeOnTheScreen();
  });
});
