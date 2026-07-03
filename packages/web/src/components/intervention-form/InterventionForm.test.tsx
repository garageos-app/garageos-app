import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InterventionForm } from './InterventionForm';
import type { InterventionType } from '@/queries/types';
import { deriveDeadlineSuggestion, formatDeadlineSuggestion } from '@/lib/deadline-suggestion';

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

// interventionTypeId and checklist item ids go through Zod's z.uuid(), which
// (zod v4) validates the version/variant nibbles — plain slugs like
// 'uuid-tagliando' fail that check. Use well-formed v4-shaped literals so
// tests that actually submit the form (not just inspect pre-fill values)
// pass schema validation.
const TYPE_ID_TAGLIANDO = '11111111-1111-4111-8111-111111111111';
const TYPE_ID_CINGHIA = '22222222-2222-4222-8222-222222222222';
const TYPE_ID_DIAGNOSI = '33333333-3333-4333-8333-333333333333';
const TYPE_ID_GOMME = '44444444-4444-4444-8444-444444444444';
const ITEM_ID_OLIO = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_ID_FILTRO = 'aaaaaaaa-0000-4000-8000-000000000002';
const ITEM_ID_CINGHIA = 'bbbbbbbb-0000-4000-8000-000000000001';
const ITEM_ID_DIAGNOSI = 'cccccccc-0000-4000-8000-000000000001';
const ITEM_ID_GOMME = 'dddddddd-0000-4000-8000-000000000001';

const types: InterventionType[] = [
  {
    id: TYPE_ID_TAGLIANDO,
    code: 'TAGLIANDO',
    nameIt: 'Tagliando',
    description: 'x',
    icon: 'wrench',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
    custom: false,
    checklistItems: [
      { id: ITEM_ID_OLIO, code: 'OLIO', nameIt: 'Cambio olio', sortOrder: 1 },
      { id: ITEM_ID_FILTRO, code: 'FILTRO', nameIt: 'Cambio filtro', sortOrder: 2 },
    ],
  },
  {
    id: TYPE_ID_CINGHIA,
    code: 'CINGHIA',
    nameIt: 'Cinghia distribuzione',
    description: 'x',
    icon: 'belt',
    suggestsDeadline: true,
    defaultDeadlineMonths: 60,
    defaultDeadlineKm: 120000,
    custom: false,
    checklistItems: [
      { id: ITEM_ID_CINGHIA, code: 'CINGHIA_CHK', nameIt: 'Sostituzione cinghia', sortOrder: 1 },
    ],
  },
  {
    id: TYPE_ID_DIAGNOSI,
    code: 'DIAGNOSI',
    nameIt: 'Diagnosi',
    description: 'x',
    icon: 'scan',
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
    custom: false,
    checklistItems: [
      { id: ITEM_ID_DIAGNOSI, code: 'DIAGNOSI_CHK', nameIt: 'Lettura centralina', sortOrder: 1 },
    ],
  },
  {
    id: TYPE_ID_GOMME,
    code: 'GOMME',
    nameIt: 'Cambio gomme',
    description: 'x',
    icon: 'tire',
    suggestsDeadline: true,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: 40000,
    custom: false,
    checklistItems: [
      { id: ITEM_ID_GOMME, code: 'GOMME_CHK', nameIt: 'Sostituzione gomme', sortOrder: 1 },
    ],
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

// Fills the other three required fields (interventionDate, odometerKm,
// description) so a submit driven purely by the checklist reaches the
// validator instead of being blocked by unrelated field errors.
function fillOtherRequiredFields() {
  fireEvent.change(screen.getByLabelText(/data intervento/i), {
    target: { value: '2026-05-06' },
  });
  fireEvent.change(screen.getByLabelText(/km al momento/i), { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText(/descrizione/i), {
    target: { value: 'Tagliando completo' },
  });
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
    expect(screen.queryByText(/aggiungi pezzo/i)).not.toBeInTheDocument();
  });

  it('does not render the checklist block until a type is selected', () => {
    renderForm();
    expect(screen.queryByText(/voci eseguite/i)).not.toBeInTheDocument();
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
    const matches = await screen.findAllByText(/data richiesta/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/correggi i campi/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-opens and pre-fills the deadline section for a suggesting type', async () => {
    renderForm();
    await selectType(/^Tagliando$/);
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByLabelText(/mesi da oggi/i)).toHaveValue(12);
    expect(screen.getByLabelText(/incremento km/i)).toHaveValue(15000);
    const tagliando = types.find((t) => t.code === 'TAGLIANDO')!;
    const expected = formatDeadlineSuggestion(deriveDeadlineSuggestion(tagliando)!);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('does not enable the deadline section for a non-suggesting type', async () => {
    renderForm();
    await selectType(/^Diagnosi$/);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/suggerito per/i)).not.toBeInTheDocument();
    expect(screen.getByText(/programma scadenza/i)).toBeInTheDocument();
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

  it('clears the months input when switching to a km-only type', async () => {
    renderForm();
    await selectType(/^Tagliando$/);
    expect(screen.getByLabelText(/mesi da oggi/i)).toHaveValue(12);
    await selectType(/^Cambio gomme$/);
    expect(screen.getByLabelText(/incremento km/i)).toHaveValue(40000);
    expect(screen.getByLabelText(/mesi da oggi/i)).toHaveValue(null);
  });

  it('submits the checked checklist item ids and no title (BR-300 happy path)', async () => {
    const onSubmit = vi.fn();
    render(
      <InterventionForm
        interventionTypes={types}
        registrationDate={null}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );
    await selectType(/^Tagliando$/);
    expect(screen.getByLabelText('Cambio olio')).toBeInTheDocument();
    expect(screen.getByLabelText('Cambio filtro')).toBeInTheDocument();

    fillOtherRequiredFields();
    await userEvent.click(screen.getByLabelText('Cambio olio'));
    await userEvent.click(screen.getByLabelText('Cambio filtro'));
    await userEvent.click(screen.getByRole('button', { name: /salva intervento/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.checklistItemIds.slice().sort()).toEqual([ITEM_ID_FILTRO, ITEM_ID_OLIO].sort());
    expect(values).not.toHaveProperty('title');
  });

  it('shows the BR-300 error and blocks submit when no checklist item is checked', async () => {
    const onSubmit = vi.fn();
    render(
      <InterventionForm
        interventionTypes={types}
        registrationDate={null}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );
    await selectType(/^Tagliando$/);
    fillOtherRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: /salva intervento/i }));

    // The message renders twice by design: once in the top-level error
    // summary (collectErrorMessages) and once as the inline per-field error
    // under the checklist block.
    const matches = await screen.findAllByText('Seleziona almeno una voce checklist.');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('resets the checked checklist items when the type changes', async () => {
    renderForm();
    await selectType(/^Tagliando$/);
    await userEvent.click(screen.getByLabelText('Cambio olio'));
    expect(screen.getByLabelText('Cambio olio')).toBeChecked();

    await selectType(/^Cinghia distribuzione$/);
    expect(screen.queryByLabelText('Cambio olio')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Sostituzione cinghia')).not.toBeChecked();
  });
});
