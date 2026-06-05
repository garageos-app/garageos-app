import { render, screen } from '@testing-library/react-native';
import { AccessLogRow } from '@/components/AccessLogRow';
import type { CustomerAccessEntry } from '@/lib/types/accessLog';

const base: CustomerAccessEntry = {
  action: 'view',
  tenantName: 'Officina Rossi',
  locationCity: 'Torino',
  occurredAt: '2026-06-05T12:32:00.000Z',
};

describe('AccessLogRow', () => {
  it('renders the view action label, tenant and city', () => {
    render(<AccessLogRow entry={base} />);
    expect(screen.getByText('Consultazione libretto')).toBeOnTheScreen();
    expect(screen.getByText(/Officina Rossi/)).toBeOnTheScreen();
    expect(screen.getByText(/Torino/)).toBeOnTheScreen();
  });

  it('renders the new_intervention action label', () => {
    render(<AccessLogRow entry={{ ...base, action: 'new_intervention' }} />);
    expect(screen.getByText('Nuovo intervento registrato')).toBeOnTheScreen();
  });

  it('omits the city separator when locationCity is null', () => {
    render(<AccessLogRow entry={{ ...base, locationCity: null }} />);
    expect(screen.getByText('Officina Rossi')).toBeOnTheScreen();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('renders the mechanic name when present', () => {
    render(<AccessLogRow entry={{ ...base, mechanicName: 'Giuseppe Verdi' }} />);
    expect(screen.getByText('Tecnico: Giuseppe Verdi')).toBeOnTheScreen();
  });

  it('omits the mechanic line when absent', () => {
    render(<AccessLogRow entry={base} />);
    expect(screen.queryByText(/Tecnico:/)).toBeNull();
  });

  it('renders the absolute datetime', () => {
    render(<AccessLogRow entry={base} />);
    expect(screen.getByText('05/06/2026 14:32')).toBeOnTheScreen();
  });
});
