import { act, render, type RenderOptions } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AuthProvider } from '@/auth/AuthContext';

/**
 * Render a component wrapped in <AuthProvider>, awaiting initial async rehydration
 * (storage.readTokens) inside act() to silence the React "not wrapped in act(...)" warning.
 *
 * Callers must `await` the return value.
 */
export async function renderWithAuth(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AuthProvider>{ui}</AuthProvider>, options);
  });
  return result;
}
