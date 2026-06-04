import { render, screen, fireEvent } from '@testing-library/react-native';
import { DeadlineRow } from '@/components/DeadlineRow';
import type { MeDeadline } from '@/lib/types/deadline';

const base: MeDeadline = {
  id: 'd1',
  vehicleId: 'v1',
  interventionTypeId: 't1',
  sourceInterventionId: null,
  dueDate: '2099-01-01',
  dueOdometerKm: null,
  description: 'Revisione biennale',
  isRecurring: false,
  recurringMonths: null,
  recurringKm: null,
  status: 'open',
  completedByInterventionId: null,
  completedAt: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  vehicle: { id: 'v1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  interventionType: { id: 't1', code: 'REVISIONE', nameIt: 'Revisione' },
};

describe('DeadlineRow', () => {
  it('renders type, vehicle and description', () => {
    render(<DeadlineRow deadline={base} onPress={() => {}} />);
    expect(screen.getByText('Revisione')).toBeOnTheScreen();
    expect(screen.getByText(/AB123CD/)).toBeOnTheScreen();
    expect(screen.getByText(/Fiat Panda/)).toBeOnTheScreen();
    expect(screen.getByText('Revisione biennale')).toBeOnTheScreen();
  });

  it('renders Scaduta for overdue status', () => {
    render(<DeadlineRow deadline={{ ...base, status: 'overdue' }} onPress={() => {}} />);
    expect(screen.getByText('Scaduta')).toBeOnTheScreen();
  });

  it('renders the km target for a km-only deadline', () => {
    render(
      <DeadlineRow
        deadline={{ ...base, dueDate: null, dueOdometerKm: 60000 }}
        onPress={() => {}}
      />,
    );
    expect(screen.getByText(/60\.000 km/)).toBeOnTheScreen();
  });

  it('fires onPress when tapped', () => {
    const onPress = jest.fn();
    render(<DeadlineRow deadline={base} onPress={onPress} />);
    fireEvent.press(screen.getByText('Revisione'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not crash with null description', () => {
    expect(() =>
      render(<DeadlineRow deadline={{ ...base, description: null }} onPress={() => {}} />),
    ).not.toThrow();
  });
});
