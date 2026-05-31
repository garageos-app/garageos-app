# Tag Button Status Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable the "Stampa/Ristampa tag" button for non-certified vehicles (pending/archived) with an inline reason, mirroring the backend BR-026 rule client-side so the request never fires.

**Architecture:** Frontend-only. `VehicleTagPrintButton` gains a `status` prop and computes `disabledByStatus = status !== 'certified'`; when disabled it renders a static reason `<p>` linked via `aria-describedby`. `VehicleDetail` passes `v.status`. Backend guard and post-click error mapping are unchanged (defense in depth for the certified→archived race).

**Tech Stack:** React + TypeScript + Vitest + Testing Library. Spec: `docs/superpowers/specs/2026-05-31-tag-button-status-gate-design.md`.

---

## File Structure

- Modify: `packages/web/src/components/VehicleTagPrintButton.tsx` — add `status` prop + gate logic + reason text.
- Modify: `packages/web/src/components/VehicleTagPrintButton.test.tsx` — default helper to `status="certified"`; add status-gate tests.
- Modify: `packages/web/src/pages/VehicleDetail.tsx:107` — pass `status={v.status}`.
- Modify: `packages/web/src/pages/VehicleDetail.test.tsx` — add archived → tag button disabled wiring test.

`VehicleStatus` (`'pending' | 'certified' | 'archived'`) is already exported from `packages/web/src/queries/types.ts:5`.

---

### Task 1: Status gate in VehicleTagPrintButton

**Files:**
- Modify: `packages/web/src/components/VehicleTagPrintButton.tsx`
- Test: `packages/web/src/components/VehicleTagPrintButton.test.tsx`

- [ ] **Step 1: Update the render helper to require `status`, then add failing status-gate tests**

In `VehicleTagPrintButton.test.tsx`, update `renderButton` so existing tests stay enabled by defaulting to `certified`:

```tsx
function renderButton(props: Partial<VehicleTagPrintButtonProps> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <VehicleTagPrintButton
        vehicleId={VEHICLE_ID}
        tagFirstPrintedAt={null}
        status="certified"
        {...props}
      />
    </QueryClientProvider>,
  );
}
```

Append a new describe block:

```tsx
describe('status gate (#6)', () => {
  it('disables the button and shows reason for pending vehicles', () => {
    renderButton({ status: 'pending' });
    expect(screen.getByRole('button', { name: /stampa tag/i })).toBeDisabled();
    expect(screen.getByText('Disponibile dopo la certificazione')).toBeVisible();
  });

  it('disables the button and shows reason for archived vehicles', () => {
    renderButton({ status: 'archived' });
    expect(screen.getByRole('button', { name: /stampa tag/i })).toBeDisabled();
    expect(screen.getByText('Non disponibile per veicoli archiviati')).toBeVisible();
  });

  it('enables the button for certified vehicles', () => {
    renderButton({ status: 'certified' });
    expect(screen.getByRole('button', { name: /stampa tag/i })).not.toBeDisabled();
  });

  it('does not fire the mutation or open the dialog when clicked while disabled', async () => {
    const user = userEvent.setup();
    // Prior print would normally make this a reprint; archived keeps it disabled.
    renderButton({ status: 'archived', tagFirstPrintedAt: '2026-04-10T12:34:56.789Z' });
    const button = screen.getByRole('button', { name: /ristampa tag/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/web exec vitest run src/components/VehicleTagPrintButton.test.tsx`
Expected: FAIL — `status` is not a valid prop yet (type error) and/or the reason text is not rendered. The four new tests fail.

- [ ] **Step 3: Implement the gate in VehicleTagPrintButton.tsx**

Add the import near the top:

```tsx
import type { VehicleStatus } from '@/queries/types';
```

Extend `Props`:

```tsx
export interface Props {
  vehicleId: string;
  tagFirstPrintedAt: string | null;
  status: VehicleStatus;
}
```

Update the function signature and add gate logic after the `label` line:

```tsx
export function VehicleTagPrintButton({ vehicleId, tagFirstPrintedAt, status }: Props) {
  const mutation = useVehicleTagDownload();
  const [reprintOpen, setReprintOpen] = useState(false);

  // See F-OFF-109: gate label and action on whether the tag has been printed before.
  const isReprint = tagFirstPrintedAt !== null;
  const label = isReprint ? 'Ristampa tag' : 'Stampa tag';

  // #6 tag-button status gate: the tag is only available for certified
  // vehicles (mirrors the backend BR-026 guard in vehicles-tag.ts). Disable
  // the button pre-emptively so the request never fires for non-certified
  // vehicles. Positive guard catches any future non-certified status.
  const disabledByStatus = status !== 'certified';
  const statusReason = !disabledByStatus
    ? null
    : status === 'archived'
      ? 'Non disponibile per veicoli archiviati'
      : 'Disponibile dopo la certificazione';
  const statusReasonId = 'tag-status-reason';
```

Update the returned JSX — the `Button` and add the reason `<p>` before the existing error `<p>`:

```tsx
  return (
    <div className="relative flex flex-col items-start">
      <Button
        type="button"
        variant="outline"
        disabled={disabledByStatus || mutation.isPending}
        aria-describedby={statusReason ? statusReasonId : undefined}
        onClick={handleClick}
      >
        <Printer className="mr-2 h-4 w-4" />
        {mutation.isPending ? 'Generazione PDF...' : label}
      </Button>
      {statusReason && (
        <p
          id={statusReasonId}
          className="absolute left-0 top-full mt-1 max-w-xs text-sm text-muted-foreground"
        >
          {statusReason}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="absolute left-0 top-full mt-1 max-w-xs text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      <VehicleTagReprintDialog
        vehicleId={vehicleId}
        open={reprintOpen}
        onOpenChange={setReprintOpen}
      />
    </div>
  );
```

Leave `mapTagError`, `errorMessage`, and `handleClick` exactly as they are — the error path is the defense-in-depth fallback for the certified→archived race.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/web exec vitest run src/components/VehicleTagPrintButton.test.tsx`
Expected: PASS — all existing tests plus the four new status-gate tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/VehicleTagPrintButton.tsx packages/web/src/components/VehicleTagPrintButton.test.tsx
git commit -m "fix(web): gate tag button on vehicle status (#6)"
```

---

### Task 2: Wire status from VehicleDetail

**Files:**
- Modify: `packages/web/src/pages/VehicleDetail.tsx` (line ~107)
- Test: `packages/web/src/pages/VehicleDetail.test.tsx`

- [ ] **Step 1: Add a failing wiring test**

In `VehicleDetail.test.tsx`, add a test (next to the existing archived test at line ~172):

```tsx
it('disables the tag button when vehicle is archived', async () => {
  setupApiFetch({
    detail: {
      ...VEHICLE_DETAIL_FIXTURE,
      vehicle: { ...VEHICLE_DETAIL_FIXTURE.vehicle, status: 'archived' },
    },
    timeline: { data: [], meta: { has_more: false } },
  });
  render(wrap({ children: <VehicleDetail /> }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /stampa tag/i })).toBeDisabled(),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/pages/VehicleDetail.test.tsx`
Expected: FAIL — the tag button is still always enabled because `status` is not passed (and the component now requires it, so this also surfaces as a type error at build/typecheck).

- [ ] **Step 3: Pass `status` to the button in VehicleDetail.tsx**

Change the line at ~107 from:

```tsx
<VehicleTagPrintButton vehicleId={v.id} tagFirstPrintedAt={v.tag_first_printed_at} />
```

to:

```tsx
<VehicleTagPrintButton
  vehicleId={v.id}
  tagFirstPrintedAt={v.tag_first_printed_at}
  status={v.status}
/>
```

- [ ] **Step 4: Run the page tests to verify they pass**

Run: `pnpm --filter @garageos/web exec vitest run src/pages/VehicleDetail.test.tsx`
Expected: PASS — the new archived test plus the existing "renders Stampa tag" / "passes tag_first_printed_at" tests (fixture status is `certified`, so the button stays enabled there).

- [ ] **Step 5: Typecheck the web package**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS — no type errors (the required `status` prop is now provided at the only call site).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/VehicleDetail.tsx packages/web/src/pages/VehicleDetail.test.tsx
git commit -m "fix(web): pass vehicle status to tag button (#6)"
```

---

## Self-Review

**Spec coverage:**
- Disabled + reason for pending/archived, enabled for certified → Task 1 (impl + tests). ✓
- Distinct copy (archived vs other non-certified) → Task 1 Step 3 `statusReason`. ✓
- `aria-describedby` static reason, not `role="alert"` → Task 1 Step 3. ✓
- No mutation / no dialog when disabled → Task 1 Step 1 fourth test. ✓
- Reprint label preserved but disabled when archived → Task 1 Step 1 fourth test (uses `tagFirstPrintedAt` set + archived → "Ristampa tag" disabled). ✓
- `VehicleDetail` passes `status` → Task 2. ✓
- Backend guard + `mapTagError` unchanged → stated in Task 1 Step 3. ✓
- No backend/schema/API/BR change → no such tasks. ✓

**Placeholder scan:** none — every step shows the exact code/command.

**Type consistency:** `VehicleStatus` imported from `@/queries/types`; `status` prop name consistent across component, tests, and `VehicleDetail`; `disabledByStatus` / `statusReason` / `statusReasonId` consistent within Task 1.

## Smoke (manuale, post-merge, leggero)

Su un veicolo per ciascuno stato:
- `pending` → button disabled + "Disponibile dopo la certificazione".
- `archived` → button disabled + "Non disponibile per veicoli archiviati".
- `certified` → button abilitato; "Stampa tag" / "Ristampa tag" funzionante come oggi.
