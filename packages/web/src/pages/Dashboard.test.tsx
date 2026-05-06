import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from './Dashboard';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe('Dashboard', () => {
  it('input invalido mostra alert con suggerimento formati', async () => {
    renderDashboard();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'abc');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/VIN.*targa.*GarageOS/i);
  });

  it('VIN valido naviga a /search?q=...&t=vin', async () => {
    navigateMock.mockClear();
    renderDashboard();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'ZFA31200000123456');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=ZFA31200000123456&t=vin');
  });

  it('plate valida naviga a /search?q=...&t=plate', async () => {
    navigateMock.mockClear();
    renderDashboard();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'AB123CD');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=AB123CD&t=plate');
  });
});
