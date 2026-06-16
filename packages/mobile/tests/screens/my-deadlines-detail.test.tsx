// Behavior tests for the personal-deadline detail screen + guided renewal
// (F-CLI-306 PR3, Task 8 — BR-296). Tier 2: happy path, the branching logic
// (recurring vs non-recurring completion), and the 404 error state.

import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import MyDeadlineDetailScreen from '../../app/my-deadlines/[id]';
import { ApiError } from '@/lib/api-error';
import type {
  PersonalDeadlineDto,
  CompletePersonalDeadlineResponse,
} from '@/lib/types/personalDeadline';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockPush = jest.fn();

let mockDetailState: {
  data?: PersonalDeadlineDto;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};
let mockCompleteResolve: CompletePersonalDeadlineResponse;
const mockCompleteMutate = jest.fn(() => Promise.resolve(mockCompleteResolve));
const mockDeleteMutate = jest.fn(() => Promise.resolve());

jest.mock('@/queries/personalDeadlines', () => ({
  usePersonalDeadline: () => mockDetailState,
  useCompletePersonalDeadline: () => ({ mutateAsync: mockCompleteMutate, isPending: false }),
  useDeletePersonalDeadline: () => ({ mutateAsync: mockDeleteMutate, isPending: false }),
}));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'd1' }),
  useRouter: () => ({ replace: mockReplace, back: mockBack, push: mockPush }),
}));

const BASE: PersonalDeadlineDto = {
  id: 'd1',
  vehicleId: 'v1',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  category: 'insurance',
  dueDate: '2026-06-16',
  reminderLeadDays: [30, 7, 0],
  notifyPush: true,
  notifyEmail: true,
  status: 'open',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

function makeState(deadline: PersonalDeadlineDto) {
  return { data: deadline, isLoading: false, isError: false, error: undefined };
}

describe('Personal deadline detail screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetailState = makeState(BASE);
    mockCompleteResolve = { personalDeadline: BASE };
  });

  it('(a) recurring deadline: completion routes to the prefilled renewal form (BR-296)', async () => {
    mockDetailState = makeState({ ...BASE, recurrenceMonths: 12, status: 'open' });
    mockCompleteResolve = {
      personalDeadline: { ...BASE, status: 'completed' },
      renewalSuggestion: {
        suggestedDueDate: '2027-06-16',
        category: 'insurance',
        recurrenceMonths: 12,
        reminderLeadDays: [30, 7, 0],
        notifyPush: true,
        notifyEmail: true,
      },
    };

    render(<MyDeadlineDetailScreen />);
    fireEvent.press(screen.getByTestId('complete-button'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockBack).not.toHaveBeenCalled();
    const target = mockReplace.mock.calls[0]![0] as {
      pathname: string;
      params: { prefill: string };
    };
    expect(target.pathname).toBe('/my-deadlines/new');
    const decoded = JSON.parse(decodeURIComponent(target.params.prefill));
    expect(decoded.suggestedDueDate).toBe('2027-06-16');
  });

  it('(b) non-recurring deadline: completion navigates back, no renewal form', async () => {
    mockDetailState = makeState({ ...BASE, status: 'open' });
    mockCompleteResolve = { personalDeadline: { ...BASE, status: 'completed' } };

    render(<MyDeadlineDetailScreen />);
    fireEvent.press(screen.getByTestId('complete-button'));

    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('(c) 404: shows the mapped "not found" error message', () => {
    mockDetailState = {
      isLoading: false,
      isError: true,
      error: new ApiError('personal_deadline.not_found', 404, 'not found'),
    };

    render(<MyDeadlineDetailScreen />);
    expect(screen.getByText('Scadenza non trovata.')).toBeOnTheScreen();
  });
});
