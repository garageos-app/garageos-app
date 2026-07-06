import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PrivateInterventionForm } from '@/components/PrivateInterventionForm';
import { useMeInterventionTypes } from '@/queries/meInterventionTypes';

// The native date picker has no JS implementation under jest. Mock it as a
// Pressable that, when pressed, emits onChange with a fixed past date.
jest.mock('@react-native-community/datetimepicker', () => {
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
        { testID, onPress: () => onChange?.({ type: 'set' }, new Date('2020-05-10T00:00:00')) },
        React.createElement(Text, null, 'picker'),
      ),
  };
});

jest.mock('@/queries/meInterventionTypes', () => ({
  useMeInterventionTypes: jest.fn(),
}));

const CATALOG = [
  {
    id: 'type-gomme',
    code: 'GOMME',
    name_it: 'Cambio Gomme',
    icon: null,
    checklist_items: [
      { id: 'i-pneu', code: 'PNEU', name_it: 'Sostituzione Pneumatici', sort_order: 0 },
      { id: 'i-conv', code: 'CONV', name_it: 'Convergenza', sort_order: 1 },
    ],
  },
];

const mockedTypes = useMeInterventionTypes as jest.Mock;

function stubCatalog(overrides: Record<string, unknown> = {}) {
  mockedTypes.mockReturnValue({ data: CATALOG, isLoading: false, isError: false, ...overrides });
}

// Drive the shared valid-date/description fields so submit is not blocked by them.
function fillDateAndDescription() {
  fireEvent.press(screen.getByTestId('intervention-date-field'));
  fireEvent.press(screen.getByTestId('intervention-date-picker'));
  fireEvent.changeText(screen.getByPlaceholderText('Descrizione'), 'Descrizione valida');
}

beforeEach(() => {
  mockedTypes.mockReset();
  stubCatalog();
});

describe('PrivateInterventionForm', () => {
  it('submits a catalog type + checklist as a snake_case body', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fireEvent.press(screen.getByTestId('checklist-item-PNEU'));
    fireEvent.press(screen.getByTestId('checklist-item-CONV'));
    fillDateAndDescription();
    fireEvent.changeText(screen.getByPlaceholderText('Chilometri (opzionale)'), '120000');
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      intervention_date: '2020-05-10',
      odometer_km: 120000,
      intervention_type_id: 'type-gomme',
      custom_type: null,
      description: 'Descrizione valida',
      checklist_item_ids: ['i-pneu', 'i-conv'],
    });
  });

  it('blocks submit and shows an inline error when no checklist item is selected', async () => {
    const onSubmit = jest.fn();
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Seleziona almeno una voce')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the Altro free-text path without checklist_item_ids', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), '  Lavaggio ');
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      intervention_date: '2020-05-10',
      odometer_km: null,
      intervention_type_id: null,
      custom_type: 'Lavaggio',
      description: 'Descrizione valida',
    });
  });

  it('resets the checklist when the type changes', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fireEvent.press(screen.getByTestId('checklist-item-PNEU'));
    // Switch to Altro and back — the previous checklist selection must be cleared.
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Seleziona almeno una voce')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prefills the selected type + checked items from initial', () => {
    render(
      <PrivateInterventionForm
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
        initial={{
          selectedKey: 'type-gomme',
          customType: '',
          checklistItemIds: ['i-pneu'],
          interventionDate: '2021-03-03',
          odometerKm: '90000',
          description: 'Cambio gomme invernali',
        }}
      />,
    );
    // The checklist for the preloaded type is rendered (detail display parity).
    expect(screen.getByTestId('checklist-item-PNEU')).toBeOnTheScreen();
    expect(screen.getByTestId('checklist-item-CONV')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('90000')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Cambio gomme invernali')).toBeOnTheScreen();
  });

  it('shows a banner when onSubmit returns an error result', async () => {
    const onSubmit = jest
      .fn()
      .mockResolvedValue({ ok: false, code: 'private_intervention.rate_limit' });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), 'Lavaggio');
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText(/limite giornaliero/)).toBeOnTheScreen();
    });
  });

  it('calls onCancel when Annulla tapped', () => {
    const onCancel = jest.fn();
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders Elimina and calls onDelete when onDelete provided', () => {
    const onDelete = jest.fn();
    render(
      <PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} onDelete={onDelete} />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Elimina' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not render Elimina without onDelete', () => {
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Elimina' })).toBeNull();
  });

  it('shows a loading indicator while the catalog loads', () => {
    stubCatalog({ data: undefined, isLoading: true });
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId('type-loading')).toBeOnTheScreen();
  });

  it('keeps the Altro path available when the catalog fails to load', async () => {
    stubCatalog({ data: undefined, isLoading: false, isError: true });
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    // No catalog chip renders, but Altro must still be selectable.
    expect(screen.queryByTestId('type-chip-GOMME')).toBeNull();
    expect(screen.getByTestId('type-chip-altro')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), 'Lavaggio');
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].custom_type).toBe('Lavaggio');
  });

  it('edit: omits checklist_item_ids when type and checklist are unchanged', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(
      <PrivateInterventionForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        submitLabel="Salva modifiche"
        initial={{
          selectedKey: 'type-gomme',
          customType: '',
          checklistItemIds: ['i-pneu'],
          interventionDate: '2021-03-03',
          odometerKm: '90000',
          description: 'Cambio gomme invernali',
        }}
      />,
    );
    // Change only an unrelated field, leave the checklist untouched.
    fireEvent.changeText(screen.getByPlaceholderText('Chilometri (opzionale)'), '91000');
    fireEvent.press(screen.getByRole('button', { name: 'Salva modifiche' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][0];
    expect(body).not.toHaveProperty('checklist_item_ids');
    expect(body.intervention_type_id).toBe('type-gomme');
  });

  it('edit: sends checklist_item_ids when the checklist changed', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(
      <PrivateInterventionForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        submitLabel="Salva modifiche"
        initial={{
          selectedKey: 'type-gomme',
          customType: '',
          checklistItemIds: ['i-pneu'],
          interventionDate: '2021-03-03',
          odometerKm: '90000',
          description: 'Cambio gomme invernali',
        }}
      />,
    );
    fireEvent.press(screen.getByTestId('checklist-item-CONV'));
    fireEvent.press(screen.getByRole('button', { name: 'Salva modifiche' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].checklist_item_ids).toEqual(['i-pneu', 'i-conv']);
  });
});
