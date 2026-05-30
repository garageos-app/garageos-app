# F-OFF-308 next-scadenza auto-suggest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an intervention type that suggests a follow-up deadline is selected in the create-intervention form, auto-open and pre-fill the "Programma scadenza" section from the type's defaults (switch ON, opt-out) and show a human-readable suggestion line.

**Architecture:** Web-only. Extract a pure helper (`deadline-suggestion.ts`) that derives the suggestion from an `InterventionType` and formats the Italian text. `DeadlineSection` renders the text; `InterventionForm` runs an effect keyed on the selected type that opens the section and sets the `createDeadline` form values. No API / DB / CDK / schema change — the backend already accepts `createDeadline` and falls back to the type's defaults.

**Tech Stack:** React + react-hook-form + Zod + shadcn/ui (Radix) + Vitest + Testing Library.

---

## Spec reference

`docs/superpowers/specs/2026-05-30-F-OFF-308-next-scadenza-auto-suggest-design.md`

Key decisions: inline pre-save auto-prefill; switch **ON (opt-out)** when the type suggests; **re-apply** the new type's defaults on type change (overwrite, no dirty-tracking); do **not** auto-enable when the type suggests but both defaults are null; hardcoded Italian (no web i18n).

## File structure

- **Create** `packages/web/src/lib/deadline-suggestion.ts` — pure derive + format helpers. One responsibility: turn an `InterventionType` into an optional suggestion and its display string.
- **Create** `packages/web/src/lib/deadline-suggestion.test.ts` — unit tests for the helper.
- **Modify** `packages/web/src/components/intervention-form/DeadlineSection.tsx` — accept an optional `suggestion` prop and render the suggestion line.
- **Modify** `packages/web/src/components/intervention-form/DeadlineSection.test.tsx` — cover the suggestion line.
- **Modify** `packages/web/src/components/intervention-form/InterventionForm.tsx` — derive the suggestion, run the prefill effect, pass the prop.
- **Modify** `packages/web/src/components/intervention-form/InterventionForm.test.tsx` — integration tests driving the Radix Select.

Test command (run from repo root): `pnpm --filter @garageos/web exec vitest run <path>`

---

### Task 1: Pure suggestion helper

**Files:**
- Create: `packages/web/src/lib/deadline-suggestion.ts`
- Test: `packages/web/src/lib/deadline-suggestion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/deadline-suggestion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InterventionType } from '@/queries/types';
import { deriveDeadlineSuggestion, formatDeadlineSuggestion } from './deadline-suggestion';

function makeType(overrides: Partial<InterventionType>): InterventionType {
  return {
    id: 'uuid-1',
    code: 'TAGLIANDO',
    nameIt: 'Tagliando',
    description: '',
    icon: 'wrench',
    category: 'maintenance',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
    custom: false,
    ...overrides,
  };
}

describe('deriveDeadlineSuggestion', () => {
  it('returns null for a null type', () => {
    expect(deriveDeadlineSuggestion(null)).toBeNull();
  });

  it('returns null when the type does not suggest a deadline', () => {
    expect(deriveDeadlineSuggestion(makeType({ suggestsDeadline: false }))).toBeNull();
  });

  it('returns null when it suggests but both defaults are null', () => {
    expect(
      deriveDeadlineSuggestion(
        makeType({ defaultDeadlineMonths: null, defaultDeadlineKm: null }),
      ),
    ).toBeNull();
  });

  it('returns the suggestion when both defaults are present', () => {
    expect(deriveDeadlineSuggestion(makeType({}))).toEqual({
      typeName: 'Tagliando',
      months: 12,
      km: 15000,
    });
  });

  it('returns months-only when km default is null', () => {
    expect(deriveDeadlineSuggestion(makeType({ defaultDeadlineKm: null }))).toEqual({
      typeName: 'Tagliando',
      months: 12,
      km: null,
    });
  });

  it('returns km-only when months default is null', () => {
    expect(deriveDeadlineSuggestion(makeType({ defaultDeadlineMonths: null }))).toEqual({
      typeName: 'Tagliando',
      months: null,
      km: 15000,
    });
  });
});

describe('formatDeadlineSuggestion', () => {
  it('formats both km and months with it-IT thousands separator', () => {
    expect(formatDeadlineSuggestion({ typeName: 'Tagliando', months: 12, km: 15000 })).toBe(
      'Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi.',
    );
  });

  it('formats km only', () => {
    expect(formatDeadlineSuggestion({ typeName: 'Gomme', months: null, km: 40000 })).toBe(
      'Suggerito per «Gomme»: prossima scadenza tra 40.000 km.',
    );
  });

  it('formats months only', () => {
    expect(formatDeadlineSuggestion({ typeName: 'Revisione', months: 24, km: null })).toBe(
      'Suggerito per «Revisione»: prossima scadenza tra 24 mesi.',
    );
  });

  it('uses singular "mese" for 1 month', () => {
    expect(formatDeadlineSuggestion({ typeName: 'X', months: 1, km: null })).toBe(
      'Suggerito per «X»: prossima scadenza tra 1 mese.',
    );
  });

  it('returns null when neither km nor months is present', () => {
    expect(formatDeadlineSuggestion({ typeName: 'X', months: null, km: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/deadline-suggestion.test.ts`
Expected: FAIL — `Failed to resolve import "./deadline-suggestion"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/deadline-suggestion.ts`:

```ts
import type { InterventionType } from '@/queries/types';

export interface DeadlineSuggestion {
  typeName: string;
  months: number | null;
  km: number | null;
}

/**
 * F-OFF-308: derive the deadline suggestion for a selected intervention type.
 * Returns null unless the type opts into suggestions (suggestsDeadline) AND
 * carries at least one default (months or km). A suggestion with both defaults
 * null is intentionally suppressed — enabling it would create a no-op deadline
 * the API discards (BR-080).
 */
export function deriveDeadlineSuggestion(
  type: InterventionType | null | undefined,
): DeadlineSuggestion | null {
  if (!type || !type.suggestsDeadline) return null;
  if (type.defaultDeadlineMonths == null && type.defaultDeadlineKm == null) return null;
  return {
    typeName: type.nameIt,
    months: type.defaultDeadlineMonths,
    km: type.defaultDeadlineKm,
  };
}

const kmFormatter = new Intl.NumberFormat('it-IT');

/**
 * Human-readable Italian suggestion line, e.g.
 * "Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi."
 * Returns null when neither km nor months is present (defensive; callers
 * already gate on deriveDeadlineSuggestion).
 */
export function formatDeadlineSuggestion(s: DeadlineSuggestion): string | null {
  const parts: string[] = [];
  if (s.km != null) parts.push(`${kmFormatter.format(s.km)} km`);
  if (s.months != null) parts.push(`${s.months} ${s.months === 1 ? 'mese' : 'mesi'}`);
  if (parts.length === 0) return null;
  return `Suggerito per «${s.typeName}»: prossima scadenza tra ${parts.join(' o ')}.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/deadline-suggestion.test.ts`
Expected: PASS — 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/deadline-suggestion.ts packages/web/src/lib/deadline-suggestion.test.ts
git commit -m "feat(web): add deadline-suggestion helper for F-OFF-308"
```

---

### Task 2: Render the suggestion line in DeadlineSection

**Files:**
- Modify: `packages/web/src/components/intervention-form/DeadlineSection.tsx`
- Test: `packages/web/src/components/intervention-form/DeadlineSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Replace the contents of `packages/web/src/components/intervention-form/DeadlineSection.test.tsx` with:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { DeadlineSection } from './DeadlineSection';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';
import type { DeadlineSuggestion } from '@/lib/deadline-suggestion';

function Wrap({
  enabled,
  suggestion,
}: {
  enabled: boolean;
  suggestion?: DeadlineSuggestion | null;
}) {
  const methods = useForm<CreateInterventionFormValues>({
    defaultValues: {
      interventionTypeId: '00000000-0000-0000-0000-000000000000',
      interventionDate: '2025-12-01',
      odometerKm: 100000,
      description: 'Test intervention',
      partsReplaced: [],
      createDeadline: { enabled, monthsFromNow: 12, kmIncrement: 15000 },
    },
  });
  return (
    <FormProvider {...methods}>
      <form>
        <DeadlineSection {...(suggestion !== undefined ? { suggestion } : {})} />
      </form>
    </FormProvider>
  );
}

describe('DeadlineSection', () => {
  it('shows toggle off by default when no defaults', () => {
    render(<Wrap enabled={false} />);
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByLabelText(/mesi/i)).not.toBeInTheDocument();
  });

  it('shows months/km inputs when toggle on', () => {
    render(<Wrap enabled={true} />);
    expect(screen.getByLabelText(/mesi/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/incremento km/i)).toBeInTheDocument();
  });

  it('renders the suggestion line when a suggestion is provided', () => {
    render(
      <Wrap enabled={true} suggestion={{ typeName: 'Tagliando', months: 12, km: 15000 }} />,
    );
    expect(
      screen.getByText('Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi.'),
    ).toBeInTheDocument();
  });

  it('renders no suggestion line when no suggestion is provided', () => {
    render(<Wrap enabled={true} />);
    expect(screen.queryByText(/suggerito per/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/components/intervention-form/DeadlineSection.test.tsx`
Expected: FAIL — the "renders the suggestion line" test fails (no line rendered; `DeadlineSection` does not yet accept a `suggestion` prop).

- [ ] **Step 3: Write the implementation**

Replace the contents of `packages/web/src/components/intervention-form/DeadlineSection.tsx` with:

```tsx
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatDeadlineSuggestion, type DeadlineSuggestion } from '@/lib/deadline-suggestion';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

interface DeadlineSectionProps {
  /** F-OFF-308 suggestion for the currently selected intervention type. */
  suggestion?: DeadlineSuggestion | null;
}

export function DeadlineSection({ suggestion = null }: DeadlineSectionProps) {
  const { control, register } = useFormContext<CreateInterventionFormValues>();
  const enabled = useWatch({ control, name: 'createDeadline.enabled' }) ?? false;
  const suggestionText = suggestion ? formatDeadlineSuggestion(suggestion) : null;

  return (
    <div className="space-y-3">
      {suggestionText && <p className="text-sm text-muted-foreground">{suggestionText}</p>}
      <Controller
        control={control}
        name="createDeadline.enabled"
        render={({ field }) => (
          <div className="flex items-center gap-2">
            <Switch checked={!!field.value} onCheckedChange={field.onChange} />
            <Label>Programma scadenza per il prossimo intervento</Label>
          </div>
        )}
      />
      {enabled && (
        <div className="grid grid-cols-2 gap-3 pl-8">
          <div>
            <Label htmlFor="months">Mesi da oggi</Label>
            <Input
              id="months"
              type="number"
              {...register('createDeadline.monthsFromNow', { valueAsNumber: true })}
            />
          </div>
          <div>
            <Label htmlFor="kmIncrement">Incremento km</Label>
            <Input
              id="kmIncrement"
              type="number"
              {...register('createDeadline.kmIncrement', { valueAsNumber: true })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/components/intervention-form/DeadlineSection.test.tsx`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/intervention-form/DeadlineSection.tsx packages/web/src/components/intervention-form/DeadlineSection.test.tsx
git commit -m "feat(web): render deadline suggestion line in DeadlineSection"
```

---

### Task 3: Auto-prefill effect + suggestion prop in InterventionForm

**Files:**
- Modify: `packages/web/src/components/intervention-form/InterventionForm.tsx`
- Test: `packages/web/src/components/intervention-form/InterventionForm.test.tsx`

- [ ] **Step 1: Write the failing test**

Replace the contents of `packages/web/src/components/intervention-form/InterventionForm.test.tsx` with:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/components/intervention-form/InterventionForm.test.tsx`
Expected: FAIL — the three new tests fail (no auto-open / prefill / suggestion behavior wired yet). The first four pre-existing tests still pass.

- [ ] **Step 3: Write the implementation**

In `packages/web/src/components/intervention-form/InterventionForm.tsx`:

First, change the React import on line 1 from:

```tsx
import { useState } from 'react';
```

to:

```tsx
import { useEffect, useState } from 'react';
```

Add the helper import next to the existing `DeadlineSection` import (after line 22):

```tsx
import { deriveDeadlineSuggestion } from '@/lib/deadline-suggestion';
```

Then, immediately after the existing `interventionTypeId` watch (line 66):

```tsx
const interventionTypeId = useWatch({ control: methods.control, name: 'interventionTypeId' });
```

add the derived suggestion and the prefill effect:

```tsx
  const selectedType = interventionTypes.find((t) => t.id === interventionTypeId) ?? null;
  const deadlineSuggestion = deriveDeadlineSuggestion(selectedType);

  // F-OFF-308: when the selected type suggests a follow-up deadline, open the
  // section and pre-fill it from the type's defaults with the switch ON
  // (opt-out — the operator confirms or disables). When the type does not
  // suggest one, force the switch OFF. Keyed on the selected type, so changing
  // the type always re-applies the new type's defaults (overwriting any prior
  // manual edits — intentional, no dirty-tracking).
  useEffect(() => {
    const suggestion = deriveDeadlineSuggestion(
      interventionTypes.find((t) => t.id === interventionTypeId) ?? null,
    );
    if (suggestion) {
      setShowDeadline(true);
      methods.setValue(
        'createDeadline',
        {
          enabled: true,
          ...(suggestion.months != null ? { monthsFromNow: suggestion.months } : {}),
          ...(suggestion.km != null ? { kmIncrement: suggestion.km } : {}),
        },
        { shouldValidate: false },
      );
    } else {
      methods.setValue('createDeadline.enabled', false, { shouldValidate: false });
    }
  }, [interventionTypeId, interventionTypes, methods]);
```

Finally, pass the suggestion to `DeadlineSection`. Change the existing render (line 226) from:

```tsx
            <DeadlineSection />
```

to:

```tsx
            <DeadlineSection suggestion={deadlineSuggestion} />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/components/intervention-form/InterventionForm.test.tsx`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/intervention-form/InterventionForm.tsx packages/web/src/components/intervention-form/InterventionForm.test.tsx
git commit -m "feat(web): auto-suggest next deadline on intervention type select (F-OFF-308)"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the web package**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS — no type errors.

- [ ] **Step 2: Run the full intervention-form + lib suite**

Run: `pnpm --filter @garageos/web exec vitest run src/components/intervention-form src/lib/deadline-suggestion.test.ts`
Expected: PASS — all tests green (DeadlineSection 4, InterventionForm 7, helper 11, plus PartsRepeater / EditInterventionDialog suites unaffected).

- [ ] **Step 3: Confirm no regression in the createIntervention wire**

Run: `pnpm --filter @garageos/web exec vitest run src/queries/createIntervention.test.tsx src/lib/validators/intervention.test.ts`
Expected: PASS — the wire shape (`transformToPayload` sends `createDeadline` only when enabled) is unchanged and still green.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/next-scadenza-auto-suggest
```

Then open a PR titled `feat(web): F-OFF-308 next-scadenza auto-suggest` with the description referencing F-OFF-308 and the design spec. No API/BR/schema/docs change (APPENDICE_A §2.2 already documents the `createDeadline` contract).

---

## Self-review

**Spec coverage:**
- Inline pre-save auto-prefill → Task 3 effect. ✓
- Switch ON (opt-out) when suggesting → Task 3 (`enabled: true`), asserted in Task 3 test. ✓
- Re-apply defaults on type change → Task 3 effect keyed on type, asserted by the A→B test. ✓
- Do not auto-enable when both defaults null → Task 1 `deriveDeadlineSuggestion` returns null; Task 3 else-branch forces OFF. Covered by Task 1 unit test. ✓
- Human-readable suggestion line with `Intl.NumberFormat('it-IT')`, km/months/both, singular "mese" → Task 1 `formatDeadlineSuggestion` + tests; rendered in Task 2. ✓
- No API/DB/CDK change → confirmed; only web files touched. ✓

**Placeholder scan:** none — every step has full code or an exact command + expected output.

**Type consistency:** `DeadlineSuggestion` (`{ typeName: string; months: number | null; km: number | null }`) defined in Task 1 and consumed identically by `DeadlineSection` (Task 2) and `InterventionForm` (Task 3). `deriveDeadlineSuggestion` / `formatDeadlineSuggestion` signatures match across tasks. `InterventionType` fields (`suggestsDeadline`, `defaultDeadlineMonths`, `defaultDeadlineKm`, `nameIt`) match `packages/web/src/queries/types.ts`.
