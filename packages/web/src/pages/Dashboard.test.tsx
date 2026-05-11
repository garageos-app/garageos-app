import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { Dashboard } from './Dashboard';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/components/CustomerAutocomplete', () => ({
  CustomerAutocomplete: ({ onSelect }: { onSelect: (c: { id: string }) => void }) => (
    <button
      type="button"
      data-testid="autocomplete-stub"
      onClick={() => onSelect({ id: 'cust-test' })}
    >
      stub
    </button>
  ),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function renderDashboard() {
  return render(<Dashboard />, { wrapper: wrap });
}

describe('Dashboard — vehicle tab (regression)', () => {
  it('input invalido mostra alert con suggerimento formati', async () => {
    renderDashboard();
    const input = screen.getByPlaceholderText(/VIN/i);
    await userEvent.type(input, 'abc');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/VIN.*targa.*GarageOS/i);
  });

  it('VIN valido naviga a /search?q=...&t=vin', async () => {
    navigateMock.mockClear();
    renderDashboard();
    const input = screen.getByPlaceholderText(/VIN/i);
    await userEvent.type(input, 'ZFA31200000123456');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=ZFA31200000123456&t=vin');
  });

  it('plate valida naviga a /search?q=...&t=plate', async () => {
    navigateMock.mockClear();
    renderDashboard();
    const input = screen.getByPlaceholderText(/VIN/i);
    await userEvent.type(input, 'AB123CD');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=AB123CD&t=plate');
  });
});

describe('Dashboard — tab toggle', () => {
  it('defaults to the vehicle tab', () => {
    renderDashboard();
    expect(screen.getByPlaceholderText(/VIN/i)).toBeInTheDocument();
    expect(screen.queryByTestId('autocomplete-stub')).not.toBeInTheDocument();
  });

  it('switches to the customer tab and renders the autocomplete', async () => {
    renderDashboard();
    await userEvent.click(screen.getByRole('tab', { name: /cliente/i }));
    expect(screen.getByTestId('autocomplete-stub')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/VIN/i)).not.toBeInTheDocument();
  });

  it('switches back to the vehicle tab', async () => {
    renderDashboard();
    await userEvent.click(screen.getByRole('tab', { name: /cliente/i }));
    await userEvent.click(screen.getByRole('tab', { name: /veicolo/i }));
    expect(screen.getByPlaceholderText(/VIN/i)).toBeInTheDocument();
  });
});

describe('Dashboard — WAI-ARIA Tabs pattern', () => {
  it('renders tabs with full WAI-ARIA Tabs pattern attributes', () => {
    renderDashboard();

    // Tablist container
    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeInTheDocument();

    // Both tab buttons present
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(2);

    // Exactly one tab is selected (the vehicle tab by default)
    const selectedTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selectedTab).toBeDefined();
    expect(selectedTab).toHaveTextContent(/veicolo/i);

    // Inactive tab has aria-selected=false and tabIndex=-1
    const inactiveTab = tabs.find((t) => t.getAttribute('aria-selected') === 'false');
    expect(inactiveTab).toBeDefined();
    expect(inactiveTab).toHaveAttribute('tabindex', '-1');

    // Tabpanel exists and is cross-referenced with the selected tab
    const tabpanel = screen.getByRole('tabpanel');
    expect(tabpanel).toBeInTheDocument();
    expect(selectedTab?.getAttribute('aria-controls')).toBe(tabpanel.getAttribute('id'));
    expect(tabpanel.getAttribute('aria-labelledby')).toBe(selectedTab?.getAttribute('id'));
  });
});

describe('Dashboard — customer tab → navigate', () => {
  it('navigates to /search?customer=<id>&t=customer when autocomplete fires onSelect', async () => {
    navigateMock.mockClear();
    renderDashboard();
    await userEvent.click(screen.getByRole('tab', { name: /cliente/i }));
    await userEvent.click(screen.getByTestId('autocomplete-stub'));
    expect(navigateMock).toHaveBeenCalledWith('/search?customer=cust-test&t=customer');
  });
});
