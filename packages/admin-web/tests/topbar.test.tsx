import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ThemeProvider } from '@/theme/ThemeContext';
import { Topbar, titleForPath } from '@/components/layout/Topbar';

function renderTopbar(path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <Topbar />
        </SidebarProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('Topbar', () => {
  it('maps paths to Italian titles', () => {
    expect(titleForPath('/')).toBe('Dashboard');
    expect(titleForPath('/officine')).toBe('Officine');
    expect(titleForPath('/officine/nuova')).toBe('Crea officina');
    expect(titleForPath('/officine/abc-123')).toBe('Dettaglio officina');
    expect(titleForPath('/audit')).toBe('Audit');
  });

  it('renders the current title and the theme toggle', () => {
    renderTopbar('/audit');
    expect(screen.getByRole('heading', { name: 'Audit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tema/i })).toBeInTheDocument();
  });
});
