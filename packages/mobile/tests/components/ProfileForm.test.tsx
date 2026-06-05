import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ProfileForm } from '@/components/ProfileForm';

const INITIAL = { firstName: 'Mario', lastName: 'Rossi', phone: '+393331112233' };

describe('ProfileForm', () => {
  it('prefills fields from initial', () => {
    render(<ProfileForm initial={INITIAL} onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByDisplayValue('Mario')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Rossi')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('+393331112233')).toBeOnTheScreen();
  });

  it('blocks submit and shows error when firstName cleared', async () => {
    const onSubmit = jest.fn();
    render(<ProfileForm initial={INITIAL} onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Nome'), '');
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(screen.getByText('Nome obbligatorio')).toBeOnTheScreen());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with body (phone null when blank)', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<ProfileForm initial={INITIAL} onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Nome'), 'Marco');
    fireEvent.changeText(screen.getByPlaceholderText('Telefono'), '');
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ firstName: 'Marco', lastName: 'Rossi', phone: null });
  });

  it('shows a banner on error result', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'boom', message: 'Errore X' });
    render(<ProfileForm initial={INITIAL} onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(screen.getByText('Errore X')).toBeOnTheScreen());
  });

  it('calls onCancel when Annulla tapped', () => {
    const onCancel = jest.fn();
    render(<ProfileForm initial={INITIAL} onSubmit={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
