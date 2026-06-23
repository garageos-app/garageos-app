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

// PushReminderBanner is mounted in this screen; mock its deps so it renders
// null (status undefined = loading) and does not affect the existing assertions.
jest.mock('@/queries/pushPermission', () => ({
  usePushPermissionStatus: () => ({ data: undefined }),
}));
jest.mock('@/lib/useEnablePush', () => ({
  useEnablePush: () => ({ enable: jest.fn() }),
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
      partsReplaced: [],
      partsReplacedCount: 0,
      status: 'active',
      isDisputed: false,
      tenant: { businessName: 'Officina Rossi', locationCity: 'Milano' },
      attachmentsCount: 0,
      generatedDeadlines: [],
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

  it('renders the parts replaced list when present', () => {
    mockDetail.data = baseData({
      intervention: {
        ...baseData().intervention,
        partsReplaced: [
          { name: 'Pastiglie freni', code: 'BRK-42', quantity: 4, notes: 'Anteriori' },
          { name: 'Olio motore', code: null, quantity: 1, notes: null },
        ],
        partsReplacedCount: 2,
      },
    });
    render(<InterventionDetailScreen />);
    expect(screen.getByText('Ricambi sostituiti (2)')).toBeTruthy();
    expect(screen.getByText('Pastiglie freni · BRK-42 · ×4')).toBeTruthy();
    expect(screen.getByText('Anteriori')).toBeTruthy();
  });

  it('renders the generated deadline when present', () => {
    mockDetail.data = baseData({
      intervention: {
        ...baseData().intervention,
        generatedDeadlines: [
          {
            id: 'dl-1',
            type: { code: 'REVISIONE', name_it: 'Revisione' },
            dueDate: '2027-05-15',
            dueOdometerKm: 120000,
            description: 'Prossima revisione',
            status: 'open',
          },
        ],
      },
    });
    render(<InterventionDetailScreen />);
    expect(screen.getByText('Prossime scadenze')).toBeTruthy();
    expect(screen.getByText('Revisione')).toBeTruthy();
    expect(screen.getByText('Prossima revisione')).toBeTruthy();
  });

  it('does not crash on a stale cached detail missing the new array fields', () => {
    // A persisted react-query cache from a pre-upgrade app version has no
    // partsReplaced / generatedDeadlines keys; the screen must default them.
    const stale = baseData();
    delete (stale.intervention as Record<string, unknown>).partsReplaced;
    delete (stale.intervention as Record<string, unknown>).generatedDeadlines;
    mockDetail.data = stale;
    render(<InterventionDetailScreen />);
    expect(screen.getByText('Contesta intervento')).toBeTruthy();
    expect(screen.queryByText(/Ricambi sostituiti/)).toBeNull();
    expect(screen.queryByText('Prossime scadenze')).toBeNull();
  });

  it('renders without crashing while pending without data (offline-paused safe)', () => {
    mockDetail.data = undefined;
    mockDetail.isLoading = false;
    render(<InterventionDetailScreen />);
    expect(screen.queryByText('Contesta intervento')).toBeNull();
  });
});
