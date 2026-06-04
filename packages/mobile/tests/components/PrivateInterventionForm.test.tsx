import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PrivateInterventionForm } from '@/components/PrivateInterventionForm';

describe('PrivateInterventionForm', () => {
  it('renders the fields and submit button', () => {
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('AAAA-MM-GG')).toBeOnTheScreen();
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
    fireEvent.changeText(screen.getByPlaceholderText('AAAA-MM-GG'), '2020-05-10');
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
    fireEvent.changeText(screen.getByPlaceholderText('AAAA-MM-GG'), '2020-05-10');
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
    fireEvent.changeText(screen.getByPlaceholderText('AAAA-MM-GG'), '2020-05-10');
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
    expect(screen.getByDisplayValue('2021-03-03')).toBeOnTheScreen();
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
});
