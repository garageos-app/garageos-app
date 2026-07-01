import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TableSkeleton } from '@/components/feedback/TableSkeleton';

describe('feedback components', () => {
  // PageHeader's only logic is the null-collapse guard: with every prop absent it
  // must render nothing, otherwise empty pages get a stray header band + spacing.
  it('PageHeader renders nothing when title, description, and actions are all absent', () => {
    const { container } = render(<PageHeader />);
    expect(container).toBeEmptyDOMElement();
  });

  it('PageHeader exposes the title as a heading and renders the actions slot', () => {
    render(<PageHeader title="Officina Rossi" actions={<button>Azione</button>} />);
    // The title must be a heading (a11y contract the shell relies on), not plain text.
    expect(screen.getByRole('heading', { name: 'Officina Rossi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Azione' })).toBeInTheDocument();
  });

  it('EmptyState renders the provided icon', () => {
    const { container } = render(<EmptyState icon={Inbox} title="Nessuna officina" />);
    // lucide icons render an <svg>; assert it actually mounts (icon is optional).
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('ErrorState renders an alert carrying the message', () => {
    render(<ErrorState message="Errore nel caricamento." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Errore nel caricamento.');
  });

  it('TableSkeleton renders the requested number of skeleton rows', () => {
    const { container } = render(<TableSkeleton rows={3} columns={4} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });
});
