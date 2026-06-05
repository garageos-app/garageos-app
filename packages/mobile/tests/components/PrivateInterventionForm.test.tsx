import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PrivateInterventionForm } from '@/components/PrivateInterventionForm';

// The native date picker has no JS implementation under jest. Mock it as a
// Pressable that, when pressed, emits onChange with a fixed past date so tests
// can drive a selection deterministically.
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
        { testID, onPress: () => onChange?.({ type: 'set' }, new Date('2020-05-10T00:00:00')) },
        React.createElement(Text, null, 'picker'),
      ),
  };
});

describe('PrivateInterventionForm', () => {
  it('renders the fields and submit button', () => {
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme')).toBeOnTheScreen();
    expect(screen.getByTestId('intervention-date-field')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Chilometri (opzionale)')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Descrizione')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Salva' })).toBeOnTheScreen();
  });

  it('blocks submit and shows inline errors when required fields are empty', async () => {
    const onSubmit = jest.fn();
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Tipo obbligatorio')).toBeOnTheScreen();
    });
    expect(screen.getByText('Descrizione obbligatoria')).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with a snake_case body (intervention_type_id null) when valid', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), '  Lavaggio ');
    fireEvent.press(screen.getByTestId('intervention-date-field'));
    fireEvent.press(screen.getByTestId('intervention-date-picker'));
    fireEvent.changeText(screen.getByPlaceholderText('Chilometri (opzionale)'), '120000');
    fireEvent.changeText(screen.getByPlaceholderText('Descrizione'), '  Lavaggio completo ');
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      intervention_date: '2020-05-10',
      odometer_km: 120000,
      intervention_type_id: null,
      custom_type: 'Lavaggio',
      description: 'Lavaggio completo',
    });
  });

  it('sends odometer_km null when left empty', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), 'Lavaggio');
    fireEvent.press(screen.getByTestId('intervention-date-field'));
    fireEvent.press(screen.getByTestId('intervention-date-picker'));
    fireEvent.changeText(screen.getByPlaceholderText('Descrizione'), 'Descrizione valida');
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].odometer_km).toBeNull();
  });

  it('shows a banner when onSubmit returns an error result', async () => {
    const onSubmit = jest
      .fn()
      .mockResolvedValue({ ok: false, code: 'private_intervention.rate_limit' });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), 'Lavaggio');
    fireEvent.press(screen.getByTestId('intervention-date-field'));
    fireEvent.press(screen.getByTestId('intervention-date-picker'));
    fireEvent.changeText(screen.getByPlaceholderText('Descrizione'), 'Descrizione valida');
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

  it('prefills fields from initial values', () => {
    render(
      <PrivateInterventionForm
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
        initial={{
          customType: 'Gomme',
          interventionDate: '2021-03-03',
          odometerKm: '90000',
          description: 'Cambio gomme invernali',
        }}
      />,
    );
    expect(screen.getByDisplayValue('Gomme')).toBeOnTheScreen();
    expect(screen.getByText('03/03/2021')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('90000')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Cambio gomme invernali')).toBeOnTheScreen();
  });

  it('renders a custom submit label', () => {
    render(
      <PrivateInterventionForm
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
        submitLabel="Salva modifiche"
      />,
    );
    expect(screen.getByRole('button', { name: 'Salva modifiche' })).toBeOnTheScreen();
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

  it('opens the native picker and stores the chosen date as yyyy-MM-dd', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), 'Lavaggio');
    fireEvent.changeText(screen.getByPlaceholderText('Descrizione'), 'Descrizione valida');
    fireEvent.press(screen.getByTestId('intervention-date-field'));
    fireEvent.press(screen.getByTestId('intervention-date-picker'));
    expect(screen.getByText('10/05/2020')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].intervention_date).toBe('2020-05-10');
  });
});
