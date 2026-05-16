import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';

describe('ForgotPasswordForm', () => {
  it('renders email input + submit button + back link', () => {
    render(<ForgotPasswordForm onSubmit={jest.fn()} onNavigateBack={jest.fn()} />);
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Invia codice' })).toBeOnTheScreen();
    expect(screen.getByText(/Torna al login/)).toBeOnTheScreen();
  });

  it('blocks submit and shows inline error when email empty', async () => {
    const onSubmit = jest.fn();
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText('Email obbligatoria')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit and shows inline error when email malformed', async () => {
    const onSubmit = jest.fn();
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'not-an-email');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText('Email non valida')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with trimmed lowercase email on valid input', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), '  Mario.Rossi@Example.com  ');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('mario.rossi@example.com');
    });
  });

  it('shows banner with mapped message when onSubmit returns ok:false', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'LimitExceededException' });
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText(/Troppi tentativi/)).toBeOnTheScreen();
    });
  });

  it('navigates back when "Torna al login" pressed', () => {
    const onBack = jest.fn();
    render(<ForgotPasswordForm onSubmit={jest.fn()} onNavigateBack={onBack} />);
    fireEvent.press(screen.getByText(/Torna al login/));
    expect(onBack).toHaveBeenCalled();
  });
});
