import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@/theme/ThemeContext';
import { ThemeToggle } from '@/theme/ThemeToggle';

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  localStorage.clear();
});

describe('theme system', () => {
  it('toggles the dark class on the document root and persists', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(screen.getByRole('button', { name: /tema/i }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('garageos-theme')).toBe('dark');
  });
});
