import { fireEvent, render, screen } from '@testing-library/react-native';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';

describe('GoogleSignInButton', () => {
  it('renders the passed label', () => {
    render(<GoogleSignInButton label="Accedi con Google" onPress={jest.fn()} />);
    expect(screen.getByText('Accedi con Google')).toBeOnTheScreen();
  });

  it('calls onPress when pressed', () => {
    const onPress = jest.fn();
    render(<GoogleSignInButton label="Accedi con Google" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('hides label and does not fire onPress when loading', () => {
    const onPress = jest.fn();
    render(<GoogleSignInButton label="Accedi con Google" onPress={onPress} loading />);
    // Label is replaced by the spinner — text must not be in the tree
    expect(screen.queryByText('Accedi con Google')).toBeNull();
    // Button is disabled — press should not invoke handler
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });
});
