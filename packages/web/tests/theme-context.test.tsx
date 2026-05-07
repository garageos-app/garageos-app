import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@/theme/ThemeContext';
import { useTheme } from '@/theme/useTheme';

function Probe() {
  const { theme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="value">{theme}</span>
      <button onClick={() => setTheme('dark')}>set-dark</button>
      <button onClick={() => setTheme('light')}>set-light</button>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('ThemeProvider', () => {
  it('default theme is light when localStorage is empty', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('value')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reads existing theme from localStorage on mount', () => {
    localStorage.setItem('garageos-theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('value')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores invalid stored values and falls back to light', () => {
    localStorage.setItem('garageos-theme', 'magenta');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('value')).toHaveTextContent('light');
  });

  it('setTheme(dark) applies the dark class on <html> and persists', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByText('set-dark'));
    expect(screen.getByTestId('value')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('garageos-theme')).toBe('dark');
  });

  it('toggleTheme flips light → dark → light and persists each step', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByText('toggle'));
    expect(screen.getByTestId('value')).toHaveTextContent('dark');
    expect(localStorage.getItem('garageos-theme')).toBe('dark');
    await user.click(screen.getByText('toggle'));
    expect(screen.getByTestId('value')).toHaveTextContent('light');
    expect(localStorage.getItem('garageos-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('useTheme outside provider throws a clear error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useTheme must be used within ThemeProvider/);
    spy.mockRestore();
  });
});
