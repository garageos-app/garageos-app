import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import React from 'react';
import { colors } from '@/theme/colors';
import type { MeDeadline } from '@/lib/types/deadline';

const mockHighlightId = 'c4e8b2a6-1d3f-4b7c-8a9e-5f2d0b6c3a7d';

const params: { highlight?: string } = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => params,
  useRouter: () => ({ push: jest.fn() }),
}));

function mockDeadline(id: string, nameIt: string): MeDeadline {
  return {
    id,
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
    interventionType: { id: 'it-1', code: 'REVISIONE', nameIt },
  };
}

jest.mock('@/queries/meDeadlines', () => ({
  useMeDeadlines: () => ({
    data: [mockDeadline('other-id', 'Tagliando'), mockDeadline(mockHighlightId, 'Revisione')],
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

// PushReminderBanner is mounted in DeadlinesScreen; mock its deps so it renders
// null (status undefined = loading) and does not affect the highlight assertions.
jest.mock('@/queries/pushPermission', () => ({
  usePushPermissionStatus: () => ({ data: undefined }),
}));
jest.mock('@/lib/useEnablePush', () => ({
  useEnablePush: () => ({ enable: jest.fn() }),
}));

import DeadlinesScreen from '../../app/(tabs)/deadlines';

function rowBackgrounds(): (string | undefined)[] {
  return screen
    .getAllByRole('button')
    .map((el) => StyleSheet.flatten(el.props.style)?.backgroundColor as string | undefined);
}

describe('DeadlinesScreen highlight from notification tap', () => {
  afterEach(() => {
    delete params.highlight;
  });

  it('tints only the row matching the highlight param', () => {
    params.highlight = mockHighlightId;
    render(<DeadlinesScreen />);

    const backgrounds = rowBackgrounds();
    expect(backgrounds).toHaveLength(2);
    expect(backgrounds.filter((bg) => bg === colors.highlightBg)).toHaveLength(1);
    // The tinted row is the one the notification referred to.
    expect(backgrounds[1]).toBe(colors.highlightBg);
  });

  it('tints nothing without the highlight param', () => {
    render(<DeadlinesScreen />);

    expect(rowBackgrounds().some((bg) => bg === colors.highlightBg)).toBe(false);
  });
});
