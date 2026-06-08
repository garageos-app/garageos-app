import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DisputeForm } from '@/components/DisputeForm';

describe('DisputeForm', () => {
  it('renders the four reason categories', () => {
    render(<DisputeForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText("L'intervento non è mai stato effettuato")).toBeTruthy();
    expect(screen.getByText('I dati riportati sono errati (km, data, pezzi)')).toBeTruthy();
    expect(screen.getByText('Non ho autorizzato questo intervento')).toBeTruthy();
    expect(screen.getByText('Altro')).toBeTruthy();
  });

  it('blocks submit and shows a field error when description is too short', async () => {
    const onSubmit = jest.fn();
    render(<DisputeForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByText('Altro'));
    fireEvent.changeText(
      screen.getByPlaceholderText('Descrivi il motivo della contestazione'),
      'corta',
    );
    fireEvent.press(screen.getByText('Invia contestazione'));
    await waitFor(() =>
      expect(screen.getByText('La descrizione deve contenere almeno 20 caratteri.')).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with the chosen category and description', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<DisputeForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByText('I dati riportati sono errati (km, data, pezzi)'));
    fireEvent.changeText(
      screen.getByPlaceholderText('Descrivi il motivo della contestazione'),
      'I chilometri riportati non corrispondono al cruscotto.',
    );
    fireEvent.press(screen.getByText('Invia contestazione'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        reasonCategory: 'wrong_data',
        description: 'I chilometri riportati non corrispondono al cruscotto.',
      }),
    );
  });
});
