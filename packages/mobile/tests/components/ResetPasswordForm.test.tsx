import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';

const VALID = {
  email: 'mario.rossi@example.com',
  code: '123456',
  password: 'newpassword1',
  confirmPassword: 'newpassword1',
};

function fillValid(opts: { includeEmail: boolean }) {
  if (opts.includeEmail) {
    fireEvent.changeText(screen.getByPlaceholderText('Email'), VALID.email);
  }
  fireEvent.changeText(screen.getByPlaceholderText('Codice'), VALID.code);
  fireEvent.changeText(screen.getByPlaceholderText('Nuova password'), VALID.password);
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), VALID.confirmPassword);
}

describe('ResetPasswordForm', () => {
  it('hides email input when initialEmail is provided', () => {
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={jest.fn()}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText('Email')).toBeNull();
    expect(screen.getByPlaceholderText('Codice')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Nuova password')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Conferma password')).toBeOnTheScreen();
  });

  it('shows email input when initialEmail is null', () => {
    render(
      <ResetPasswordForm
        initialEmail={null}
        onSubmit={jest.fn()}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
  });

  it('blocks submit and shows inline errors when empty', async () => {
    const onSubmit = jest.fn();
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText('Codice obbligatorio')).toBeOnTheScreen();
    });
    expect(screen.getByText('Password obbligatoria')).toBeOnTheScreen();
    expect(screen.getByText('Conferma la password')).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit on password confirm mismatch', async () => {
    const onSubmit = jest.fn();
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'different1');
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText('Le password non coincidono')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with normalized payload on valid input', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        email: VALID.email,
        code: VALID.code,
        newPassword: VALID.password,
      });
    });
  });

  it('shows banner with mapped message on CodeMismatchException', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'CodeMismatchException' });
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText(/Codice non valido/)).toBeOnTheScreen();
    });
  });

  it('routes InvalidPasswordException to inline password error (not banner)', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'InvalidPasswordException' });
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText(/La password non rispetta i requisiti/)).toBeOnTheScreen();
    });
    // banner role=alert should not be on screen
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('resend cooldown', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it('starts 60s cooldown on successful resend', async () => {
      const onResend = jest.fn().mockResolvedValue({ ok: true });
      render(
        <ResetPasswordForm
          initialEmail={VALID.email}
          onSubmit={jest.fn()}
          onResend={onResend}
          onNavigateBack={jest.fn()}
        />,
      );
      fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo il codice/ }));
      await waitFor(() => expect(onResend).toHaveBeenCalledWith(VALID.email));
      await waitFor(() => {
        expect(screen.getByText(/Invia di nuovo il codice \(60s\)/)).toBeOnTheScreen();
      });
    });

    it('decrements cooldown each second', async () => {
      const onResend = jest.fn().mockResolvedValue({ ok: true });
      render(
        <ResetPasswordForm
          initialEmail={VALID.email}
          onSubmit={jest.fn()}
          onResend={onResend}
          onNavigateBack={jest.fn()}
        />,
      );
      fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo il codice/ }));
      await waitFor(() => {
        expect(screen.getByText(/Invia di nuovo il codice \(60s\)/)).toBeOnTheScreen();
      });
      act(() => {
        jest.advanceTimersByTime(3000);
      });
      expect(screen.getByText(/Invia di nuovo il codice \(57s\)/)).toBeOnTheScreen();
    });
  });
});
