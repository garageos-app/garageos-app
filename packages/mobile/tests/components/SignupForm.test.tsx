import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SignupForm } from '@/components/auth/SignupForm';

const VALID = {
  email: 'mario.rossi@example.com',
  password: 'miapassword1',
  confirmPassword: 'miapassword1',
  firstName: 'Mario',
  lastName: 'Rossi',
};

function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('Email'), VALID.email);
  fireEvent.changeText(screen.getByPlaceholderText('Password'), VALID.password);
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), VALID.confirmPassword);
  fireEvent.changeText(screen.getByPlaceholderText('Nome'), VALID.firstName);
  fireEvent.changeText(screen.getByPlaceholderText('Cognome'), VALID.lastName);
}

describe('SignupForm', () => {
  it('renders all 5 fields plus helper text and submit', () => {
    render(<SignupForm onSubmit={jest.fn()} onNavigateLogin={jest.fn()} />);
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Password')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Conferma password')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Nome')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Cognome')).toBeOnTheScreen();
    expect(screen.getByText(/Almeno 8 caratteri/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Registrati' })).toBeOnTheScreen();
  });

  it('blocks submit and shows inline errors when fields invalid', async () => {
    const onSubmit = jest.fn();
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText('Email obbligatoria')).toBeOnTheScreen();
    });
    expect(screen.getByText('Password obbligatoria')).toBeOnTheScreen();
    expect(screen.getByText('Nome obbligatorio')).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit on password confirm mismatch', async () => {
    const onSubmit = jest.fn();
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'different1');
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText('Le password non coincidono')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with trimmed/lowercased payload on valid submit', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true, customer: { id: 'c1' } });
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), '  Mario.Rossi@Example.com ');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'miapassword1');
    fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'miapassword1');
    fireEvent.changeText(screen.getByPlaceholderText('Nome'), '  Mario  ');
    fireEvent.changeText(screen.getByPlaceholderText('Cognome'), '  Rossi ');
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'mario.rossi@example.com',
      password: 'miapassword1',
      firstName: 'Mario',
      lastName: 'Rossi',
    });
  });

  it('shows banner when onSubmit returns email_already_active', async () => {
    const onSubmit = jest.fn().mockResolvedValue({
      ok: false,
      code: 'auth.signup.email_already_active',
      message: 'Un account con questa email è già registrato.',
    });
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText(/Un account con questa email/)).toBeOnTheScreen();
    });
  });

  it('shows inline password error when API returns password_policy_violation', async () => {
    const onSubmit = jest.fn().mockResolvedValue({
      ok: false,
      code: 'auth.signup.password_policy_violation',
      message: 'La password non rispetta i requisiti.',
    });
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      // The mapped IT message from error-messages.ts should appear under the password field
      expect(screen.getByText(/La password non rispetta i requisiti/)).toBeOnTheScreen();
    });
  });

  it('guards against double submit', async () => {
    const onSubmit = jest.fn(
      () =>
        new Promise(() => {
          // pending forever
        }) as Promise<{ ok: true }>,
    );
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    const button = screen.getByRole('button', { name: 'Registrati' });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('navigates to login when "Accedi" link tapped', () => {
    const onNavigateLogin = jest.fn();
    render(<SignupForm onSubmit={jest.fn()} onNavigateLogin={onNavigateLogin} />);
    fireEvent.press(screen.getByText(/Hai già un account/));
    expect(onNavigateLogin).toHaveBeenCalledTimes(1);
  });
});
