import { fireEvent, render, screen } from '@testing-library/react-native';

import { VehicleHistoryExportButton } from '@/components/VehicleHistoryExportButton';
import { ApiError } from '@/lib/api-error';

// Controllable mock of the export mutation hook.
const mockMutate = jest.fn();
let mockState: { isPending: boolean; isError: boolean; error: Error | null } = {
  isPending: false,
  isError: false,
  error: null,
};
jest.mock('@/queries/vehicleHistoryPdf', () => ({
  useVehicleHistoryPdfExport: () => ({ mutate: mockMutate, ...mockState }),
}));

beforeEach(() => {
  mockMutate.mockReset();
  mockState = { isPending: false, isError: false, error: null };
});

describe('VehicleHistoryExportButton', () => {
  it('renders idle and exports the vehicle id on press', () => {
    render(<VehicleHistoryExportButton vehicleId="veh-1" />);
    fireEvent.press(screen.getByText('Esporta PDF storico'));
    expect(mockMutate).toHaveBeenCalledWith('veh-1');
  });

  it('shows the generating label while pending', () => {
    mockState = { isPending: true, isError: false, error: null };
    render(<VehicleHistoryExportButton vehicleId="veh-1" />);
    expect(screen.getByText('Generazione PDF…')).toBeTruthy();
    expect(screen.queryByText('Esporta PDF storico')).toBeNull();
  });

  it('maps me.vehicle.not_found to a specific message', () => {
    mockState = {
      isPending: false,
      isError: true,
      error: new ApiError('me.vehicle.not_found', 404, 'x'),
    };
    render(<VehicleHistoryExportButton vehicleId="veh-1" />);
    expect(screen.getByText('Veicolo non trovato')).toBeTruthy();
  });

  it('shows the PDF-specific fallback for any other error', () => {
    mockState = {
      isPending: false,
      isError: true,
      error: new ApiError('network.unreachable', 0, 'x'),
    };
    render(<VehicleHistoryExportButton vehicleId="veh-1" />);
    expect(screen.getByText('Impossibile generare il PDF. Riprova.')).toBeTruthy();
  });
});
