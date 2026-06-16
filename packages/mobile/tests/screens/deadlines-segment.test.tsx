import { render, screen } from '@testing-library/react-native';
import React from 'react';
import type { MeDeadline } from '@/lib/types/deadline';
import type { PersonalDeadlineDto } from '@/lib/types/personalDeadline';

// Mutable params so we can drive a deep-link param change across re-renders,
// mirroring Expo Router keeping the tab mounted.
const params: { highlight?: string; segment?: string } = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => params,
  useRouter: () => ({ push: jest.fn() }),
}));

function mockOfficinaDeadline(): MeDeadline {
  return {
    id: 'off-1',
    vehicleId: 'veh-1',
    interventionTypeId: 'it-1',
    sourceInterventionId: null,
    dueDate: '2026-07-01',
    dueOdometerKm: null,
    description: null,
    isRecurring: false,
    recurringMonths: null,
    recurringKm: null,
    status: 'open',
    completedByInterventionId: null,
    completedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    vehicle: { id: 'veh-1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
    interventionType: { id: 'it-1', code: 'REVISIONE', nameIt: 'Revisione' },
  };
}

jest.mock('@/queries/meDeadlines', () => ({
  useMeDeadlines: () => ({
    data: [mockOfficinaDeadline()],
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

jest.mock('@/queries/personalDeadlines', () => ({
  usePersonalDeadlines: () => ({
    data: [] as PersonalDeadlineDto[],
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

import DeadlinesScreen from '../../app/(tabs)/deadlines';

describe('DeadlinesScreen segment sync from deep-link params', () => {
  afterEach(() => {
    delete params.highlight;
    delete params.segment;
  });

  it('switches to officina when a highlight param arrives while on personali', () => {
    // Start on the personal segment (deep-linked from a personal reminder tap).
    params.segment = 'personal';
    const { rerender } = render(<DeadlinesScreen />);
    // Personal list is empty → its empty state shows, officina row does not.
    expect(screen.queryByText('Revisione')).toBeNull();

    // A later officina deadline.reminder tap routes here with `highlight` and no
    // segment param: the effect must flip the segment back to officina.
    delete params.segment;
    params.highlight = 'off-1';
    rerender(<DeadlinesScreen />);

    expect(screen.getByText('Revisione')).toBeTruthy();
  });
});
