import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { MeVehicleSummary } from '@/lib/types/vehicle';

// The native date picker has no JS implementation under jest. Mock it as a
// Pressable that, when pressed, emits onChange with a fixed future date so tests
// can drive a selection deterministically (must be in the future — the
// validator rejects past dates, see validatePersonalDeadlineForm).
jest.mock('@react-native-community/datetimepicker', () => {
  // jest.mock factories are hoisted above imports, so deps must be require()'d
  // inline — the ESLint require-import rule does not apply here.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    default: ({
      testID,
      onChange,
    }: {
      testID?: string;
      onChange?: (e: unknown, d?: Date) => void;
    }) =>
      React.createElement(
        Pressable,
        { testID, onPress: () => onChange?.({ type: 'set' }, new Date('2099-05-10T00:00:00')) },
        React.createElement(Text, null, 'picker'),
      ),
  };
});

const mockUseMeVehiclesList = jest.fn();
jest.mock('@/queries/meVehicles', () => ({
  useMeVehiclesList: () => mockUseMeVehiclesList(),
}));

import { PersonalDeadlineForm } from '@/components/PersonalDeadlineForm';

function vehicle(overrides: Partial<MeVehicleSummary> = {}): MeVehicleSummary {
  return {
    id: 'veh-1',
    garageCode: 'GAR-1',
    vin: 'WVWZZZ1JZXW000001',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    year: 2020,
    vehicleType: 'car',
    fuelType: 'petrol',
    status: 'certified',
    currentOwnership: { id: 'own-1', startedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

function mockVehicles(list: MeVehicleSummary[]) {
  mockUseMeVehiclesList.mockReturnValue({ data: list, isLoading: false });
}

describe('PersonalDeadlineForm', () => {
  beforeEach(() => {
    mockUseMeVehiclesList.mockReset();
  });

  it("reveals the custom label when category is 'other' and blocks submit when empty (BR-294)", async () => {
    mockVehicles([vehicle()]);
    const onSubmit = jest.fn();
    render(
      <PersonalDeadlineForm
        mode="create"
        submitLabel="Crea scadenza"
        submitting={false}
        onSubmit={onSubmit}
      />,
    );

    // Label field hidden for the default (insurance) category.
    expect(screen.queryByTestId('custom-label-input')).toBeNull();

    // Pick a valid future date so the only error is the missing custom label.
    fireEvent.press(screen.getByTestId('due-date-field'));
    fireEvent.press(screen.getByTestId('due-date-picker'));

    fireEvent.press(screen.getByTestId('category-chip-other'));
    expect(screen.getByTestId('custom-label-input')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Crea scadenza' }));

    await waitFor(() => {
      expect(screen.getByText("Specifica un'etichetta")).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reveals the daily-tail stepper and submits the chosen tail count', async () => {
    mockVehicles([vehicle()]);
    const onSubmit = jest.fn();
    render(
      <PersonalDeadlineForm
        mode="create"
        submitLabel="Crea scadenza"
        submitting={false}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.press(screen.getByTestId('due-date-field'));
    fireEvent.press(screen.getByTestId('due-date-picker'));

    // Tail stepper hidden until the toggle is on.
    expect(screen.queryByTestId('tail-stepper-value')).toBeNull();
    fireEvent(screen.getByTestId('tail-toggle'), 'valueChange', true);

    // Default tail value is 1; bump it to 3.
    expect(screen.getByTestId('tail-stepper-value')).toHaveTextContent('1');
    fireEvent.press(screen.getByTestId('tail-stepper-inc'));
    fireEvent.press(screen.getByTestId('tail-stepper-inc'));
    expect(screen.getByTestId('tail-stepper-value')).toHaveTextContent('3');

    fireEvent.press(screen.getByRole('button', { name: 'Crea scadenza' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].reminderDailyTailDays).toBe(3);
  });

  it('happy path: pre-selects the only vehicle and submits a valid body', async () => {
    mockVehicles([vehicle()]);
    const onSubmit = jest.fn();
    render(
      <PersonalDeadlineForm
        mode="create"
        submitLabel="Crea scadenza"
        submitting={false}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.press(screen.getByTestId('due-date-field'));
    fireEvent.press(screen.getByTestId('due-date-picker'));

    fireEvent.press(screen.getByRole('button', { name: 'Crea scadenza' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][0];
    expect(body.vehicleId).toBe('veh-1');
    expect(body.category).toBe('insurance');
    expect(body.dueDate).toBe('2099-05-10');
    expect(body.reminderLeadDays).toEqual([30, 7, 0]);
    // Create mode omits cleared optional fields rather than sending null.
    expect('reminderDailyTailDays' in body).toBe(false);
    expect('recurrenceMonths' in body).toBe(false);
    expect('customLabel' in body).toBe(false);
    expect('notes' in body).toBe(false);
  });

  it('shows a loading message while vehicles load', () => {
    mockUseMeVehiclesList.mockReturnValue({ data: undefined, isLoading: true });
    render(
      <PersonalDeadlineForm
        mode="create"
        submitLabel="Crea scadenza"
        submitting={false}
        onSubmit={jest.fn()}
      />,
    );
    expect(screen.getByText('Caricamento veicoli…')).toBeOnTheScreen();
  });
});
