import { render, screen } from '@testing-library/react-native';
import React from 'react';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

const mockDetail = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
};
jest.mock('@/queries/meShopInterventionDetail', () => ({
  useMeShopInterventionDetail: () => mockDetail,
}));

import InterventionDetailScreen from '../../app/interventions/[id]';

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    intervention: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicleId: 'veh-1',
      interventionDate: '2026-05-01',
      odometerKm: 84210,
      type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
      title: 'Tagliando completo',
      description: 'desc',
      partsReplacedCount: 2,
      status: 'active',
      isDisputed: false,
      tenant: { businessName: 'Officina Rossi', locationCity: 'Milano' },
      attachmentsCount: 0,
    },
    disputes: [],
    ...overrides,
  };
}

describe('InterventionDetailScreen', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockDetail.isLoading = false;
    mockDetail.isError = false;
  });

  it('shows the "Contesta" button when there is no active dispute', () => {
    mockDetail.data = baseData();
    render(<InterventionDetailScreen />);
    expect(screen.getByText('Contesta intervento')).toBeTruthy();
  });

  it('hides "Contesta" and shows the thread when a dispute is active', () => {
    mockDetail.data = baseData({
      intervention: { ...baseData().intervention, isDisputed: true, status: 'disputed' },
      disputes: [
        {
          id: 'd-1',
          reasonCategory: 'wrong_data',
          customerDescription: 'I km sono errati',
          status: 'responded',
          createdAt: '2026-05-02T10:00:00.000Z',
          tenantResponse: 'Verificato',
          tenantResponseAt: '2026-05-03T09:00:00.000Z',
          resolvedAt: null,
        },
      ],
    });
    render(<InterventionDetailScreen />);
    expect(screen.queryByText('Contesta intervento')).toBeNull();
    expect(screen.getByText('Risposta ricevuta')).toBeTruthy();
    expect(screen.getByText('Verificato')).toBeTruthy();
  });

  it('renders without crashing while pending without data (offline-paused safe)', () => {
    mockDetail.data = undefined;
    mockDetail.isLoading = false;
    render(<InterventionDetailScreen />);
    expect(screen.queryByText('Contesta intervento')).toBeNull();
  });
});
