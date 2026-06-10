import { render, screen } from '@testing-library/react-native';
import VehicleDetailScreen from '../../app/(tabs)/vehicles/[id]';
import * as meVehicles from '@/queries/meVehicles';
import type { MeVehicleDetail } from '@/lib/types/vehicle';

const VALID_ID = '33333333-3333-4333-8333-333333333333';

jest.mock('@/queries/meVehicles');
jest.mock('@/queries/meVehicleTimeline', () => ({
  useMeVehicleTimeline: () => ({
    isLoading: false,
    isError: false,
    error: null,
    data: { data: [] },
    refetch: jest.fn(),
  }),
}));
jest.mock('@/queries/meDeadlines', () => ({
  useMeDeadlines: () => ({
    isLoading: false,
    isError: false,
    error: null,
    data: undefined,
    refetch: jest.fn(),
  }),
  deadlinesForVehicle: () => [],
}));
jest.mock('@/queries/meVehicleAccessLog', () => ({
  useMeVehicleAccessLog: () => ({
    isLoading: false,
    isError: false,
    error: null,
    data: [],
    refetch: jest.fn(),
  }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({ id: '33333333-3333-4333-8333-333333333333' }),
}));

const mockedVehicles = meVehicles as jest.Mocked<typeof meVehicles>;

const certifiedDetail: MeVehicleDetail = {
  vehicle: {
    id: VALID_ID,
    garageCode: 'GO-001-AAAA',
    vin: 'WVWZZZ1JZXW000001',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    version: null,
    year: 2020,
    registrationDate: null,
    vehicleType: 'car',
    fuelType: 'petrol',
    engineDisplacement: null,
    powerKw: null,
    color: null,
    status: 'certified',
    certifiedAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
  },
  currentOwnership: { id: 'o1', startedAt: '2024-01-01T00:00:00Z' },
};

const pendingDetail: MeVehicleDetail = {
  ...certifiedDetail,
  vehicle: {
    ...certifiedDetail.vehicle,
    status: 'pending',
    garageCode: null,
    certifiedAt: null,
  },
};

function mockDetail(detail: MeVehicleDetail) {
  mockedVehicles.useMeVehicleDetail.mockReturnValue({
    data: detail,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  } as unknown as ReturnType<typeof meVehicles.useMeVehicleDetail>);
}

describe('VehicleDetail screen — pending state', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the pending banner and hides the Codice line for a pending vehicle', () => {
    mockDetail(pendingDetail);
    render(<VehicleDetailScreen />);
    expect(
      screen.getByText(
        "Veicolo in attesa di certificazione. Portalo in un'officina GarageOS per la verifica del libretto e il codice ufficiale.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Codice:/)).toBeNull();
  });

  it('shows the Codice line and no banner for a certified vehicle', () => {
    mockDetail(certifiedDetail);
    render(<VehicleDetailScreen />);
    expect(screen.getByText('Codice: GO-001-AAAA')).toBeOnTheScreen();
    expect(screen.queryByText(/Veicolo in attesa di certificazione/)).toBeNull();
  });
});
