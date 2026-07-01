import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TableSkeleton } from '@/components/feedback/TableSkeleton';

describe('feedback components', () => {
  it('PageHeader renders title, description, and actions', () => {
    render(
      <PageHeader
        title="Officina Rossi"
        description="Dettaglio"
        actions={<button>Azione</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Officina Rossi' })).toBeInTheDocument();
    expect(screen.getByText('Dettaglio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Azione' })).toBeInTheDocument();
  });

  it('EmptyState shows the message and icon', () => {
    render(<EmptyState icon={Inbox} title="Nessuna officina" description="Crea la prima." />);
    expect(screen.getByText('Nessuna officina')).toBeInTheDocument();
    expect(screen.getByText('Crea la prima.')).toBeInTheDocument();
  });

  it('ErrorState renders an alert with the message', () => {
    render(<ErrorState message="Errore nel caricamento." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Errore nel caricamento.');
  });

  it('TableSkeleton renders the requested number of skeleton rows', () => {
    const { container } = render(<TableSkeleton rows={3} columns={4} />);
    // 3 body rows (header row uses <th>, body uses <td>)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });
});
