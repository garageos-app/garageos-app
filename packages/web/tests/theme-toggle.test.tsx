import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@/theme/ThemeContext';
import { ThemeToggle } from '@/theme/ThemeToggle';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('ThemeToggle', () => {
  it('renders an accessible button with italian aria-label', () => {
    renderToggle();
    expect(screen.getByRole('button', { name: /cambia tema chiaro\/scuro/i })).toBeInTheDocument();
  });

  it('shows the Moon icon when theme is light (click target = "go dark")', () => {
    renderToggle();
    const btn = screen.getByRole('button', { name: /cambia tema chiaro\/scuro/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn.querySelector('[data-theme-icon="moon"]')).not.toBeNull();
    expect(btn.querySelector('[data-theme-icon="sun"]')).toBeNull();
  });

  it('shows the Sun icon when theme is dark (click target = "go light")', () => {
    localStorage.setItem('garageos-theme', 'dark');
    renderToggle();
    const btn = screen.getByRole('button', { name: /cambia tema chiaro\/scuro/i });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn.querySelector('[data-theme-icon="sun"]')).not.toBeNull();
    expect(btn.querySelector('[data-theme-icon="moon"]')).toBeNull();
  });

  it('clicking flips light → dark and updates icon + aria-pressed', async () => {
    const user = userEvent.setup();
    renderToggle();
    const btn = screen.getByRole('button', { name: /cambia tema chiaro\/scuro/i });
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn.querySelector('[data-theme-icon="sun"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
