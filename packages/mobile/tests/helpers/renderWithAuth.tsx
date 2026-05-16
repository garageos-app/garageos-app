import { act, render, type RenderOptions } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AuthProvider } from '@/auth/AuthContext';

/**
 * Render a component wrapped in <AuthProvider>, then flush AuthProvider's async
 * rehydration effect (storage.readTokens) inside act() to silence the React
 * "not wrapped in act(...)" warning.
 *
 * The render itself must happen OUTSIDE act() — wrapping it inside causes the
 * test renderer to unmount when act resolves, leaving result.root inaccessible.
 *
 * Callers must `await` the return value.
 */
export async function renderWithAuth(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): Promise<ReturnType<typeof render>> {
  const result = render(<AuthProvider>{ui}</AuthProvider>, options);
  await act(async () => {
    // Flush pending state updates from AuthProvider's rehydration useEffect.
  });
  return result;
}
