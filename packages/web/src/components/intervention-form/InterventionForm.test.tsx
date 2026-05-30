import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InterventionForm } from './InterventionForm';
import type { InterventionType } from '@/queries/types';

// Radix Select uses pointer-capture + scrollIntoView, which jsdom does not
// implement. Stub them so userEvent can open the listbox and click options.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const types: InterventionType[] = [
  {
    id: 'uuid-tagliando',
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
  {
    id: 'uuid-cinghia',
    code: 'CINGHIA',
    nameIt: 'Cinghia distribuzione',
    description: 'x',
    icon: 'belt',
    category: 'maintenance',
    suggestsDeadline: true,
    defaultDeadlineMonths: 60,
    defaultDeadlineKm: 120000,
    custom: false,
  },
  {
    id: 'uuid-diagnosi',
    code: 'DIAGNOSI',
    nameIt: 'Diagnosi',
    description: 'x',
    icon: 'scan',
    category: 'repair',
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
    custom: false,
  },
];

function renderForm() {
  return render(
    <InterventionForm
      interventionTypes={types}
      registrationDate={null}
      onSubmit={vi.fn()}
      submitting={false}
    />,
  );
}

async function selectType(name: RegExp) {
  await userEvent.click(screen.getByLabelText(/tipo intervento/i));
  await userEvent.click(await screen.findByRole('option', { name }));
}

describe('InterventionForm', () => {
  it('renders 4 required fields visible by default', () => {
    renderForm();
    expect(screen.getByLabelText(/data intervento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tipo intervento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/km al momento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/descrizione/i)).toBeInTheDocument();
  });

  it('keeps optional sections collapsed by default', () => {
    renderForm();
    expect(screen.queryByLabelText(/^titolo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/aggiungi pezzo/i)).not.toBeInTheDocument();
  });

  it('expands optional title when clicked', async () => {
    renderForm();
    await userEvent.click(screen.getByText(/aggiungi titolo/i));
    expect(screen.getByLabelText(/titolo \(opz/i)).toBeInTheDocument();
  });

  it('shows zod validation messages on empty submit', async () => {
    renderForm();
    await userEvent.click(screen.getByRole('button', { name: /salva intervento/i }));
    const matches = await screen.findAllByText(/data richiesta/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/correggi i campi/i);
  });

  it('auto-opens and pre-fills the deadline section for a suggesting type', async () => {
    renderForm();
    await selectType(/^Tagliando$/);
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByLabelText(/mesi da oggi/i)).toHaveValue(12);
    expect(screen.getByLabelText(/incremento km/i)).toHaveValue(15000);
    expect(
      screen.getByText('Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi.'),
    ).toBeInTheDocument();
  });

  it('does not enable the deadline section for a non-suggesting type', async () => {
    renderForm();
    await selectType(/^Diagnosi$/);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/suggerito per/i)).not.toBeInTheDocument();
  });

  it('re-applies the new type defaults when the type changes', async () => {
    renderForm();
    await selectType(/^Tagliando$/);
    expect(screen.getByLabelText(/mesi da oggi/i)).toHaveValue(12);
    await selectType(/^Cinghia distribuzione$/);
    expect(screen.getByLabelText(/mesi da oggi/i)).toHaveValue(60);
    expect(screen.getByLabelText(/incremento km/i)).toHaveValue(120000);
    expect(screen.getByText(/«Cinghia distribuzione»/)).toBeInTheDocument();
  });
});
