import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InterventionForm } from './InterventionForm';
import type { InterventionType } from '@/queries/types';

const types: InterventionType[] = [
  {
    id: 'uuid-1',
    code: 'TAGLIANDO',
    nameIt: 'Tagliando',
    description: 'x',
    icon: 'wrench',
    category: 'maintenance',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
    custom: false,
  },
];

describe('InterventionForm', () => {
  it('renders 4 required fields visible by default', () => {
    render(
      <InterventionForm
        interventionTypes={types}
        registrationDate={null}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    expect(screen.getByLabelText(/data intervento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tipo intervento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/km al momento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/descrizione/i)).toBeInTheDocument();
  });

  it('keeps optional sections collapsed by default', () => {
    render(
      <InterventionForm
        interventionTypes={types}
        registrationDate={null}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    expect(screen.queryByLabelText(/^titolo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/aggiungi pezzo/i)).not.toBeInTheDocument();
  });

  it('expands optional title when clicked', async () => {
    render(
      <InterventionForm
        interventionTypes={types}
        registrationDate={null}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    await userEvent.click(screen.getByText(/aggiungi titolo/i));
    expect(screen.getByLabelText(/titolo \(opz/i)).toBeInTheDocument();
  });

  it('shows zod validation messages on empty submit', async () => {
    const onSubmit = vi.fn();
    render(
      <InterventionForm
        interventionTypes={types}
        registrationDate={null}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /salva intervento/i }));
    expect(await screen.findByText(/data richiesta/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
