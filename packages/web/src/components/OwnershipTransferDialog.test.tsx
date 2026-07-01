// F-OFF-110 PR-2 — component tests for the 3-step OwnershipTransferDialog.
// Tests cover: the recipient -> reason/notes -> confirm wizard flow and submit payload.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { OwnershipTransferDialog } from './OwnershipTransferDialog';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any vi.mock() call.
// ---------------------------------------------------------------------------
const { mockMutateAsync, mockUseOwnershipTransfer } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseOwnershipTransfer: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock Radix Dialog so portal rendering works in JSDOM.
// ---------------------------------------------------------------------------
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// ---------------------------------------------------------------------------
// Mock Radix Select so step-2 (Motivo) renders in JSDOM without a portal.
// We test navigation via the "Avanti" button which is only enabled when
// reason !== ''. We programmatically set reason via the onValueChange path
// by triggering the hidden select. Simpler: mock the entire Select family
// as a plain <select> so userEvent.selectOptions() works.
// ---------------------------------------------------------------------------
vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select
      data-testid="reason-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="">{placeholder}</option>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

// ---------------------------------------------------------------------------
// Mock Radix Switch — used in the "nuovo cessionario" form sub-path.
// Not exercised in this test; stub to avoid JSDOM pointer-event issues.
// ---------------------------------------------------------------------------
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id?: string;
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock customerSearch hook — returns one customer so step 1 can advance.
// ---------------------------------------------------------------------------
vi.mock('@/queries/customerSearch', () => ({
  useCustomerSearch: () => ({
    data: {
      data: [
        {
          id: 'cust-aaa',
          firstName: 'Luca',
          lastName: 'Bianchi',
          email: 'luca@example.com',
        },
      ],
    },
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Mock ownershipTransfer hook — controllable mutateAsync spy.
// ---------------------------------------------------------------------------
vi.mock('@/queries/ownershipTransfer', () => ({
  useOwnershipTransfer: mockUseOwnershipTransfer,
}));

// ---------------------------------------------------------------------------
// Mock sonner — prevent console noise and capture calls if needed.
// ---------------------------------------------------------------------------
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock api-client — avoids module-init errors when the component is imported.
// The mutation hook is mocked above so apiFetch won't actually be called.
// ---------------------------------------------------------------------------
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Test harness helpers.
// ---------------------------------------------------------------------------
const VEHICLE_ID = 'veh-00000000-0000-4000-8000-000000000001';
const CURRENT_OWNER_ID = 'owner-11111111-1111-4111-8111-111111111111';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

function renderDialog(props?: Partial<{ onOpenChange: () => void }>) {
  const { Wrapper } = makeWrapper();
  const onOpenChange = props?.onOpenChange ?? vi.fn();
  render(
    <Wrapper>
      <OwnershipTransferDialog
        open={true}
        onOpenChange={onOpenChange}
        vehicleId={VEHICLE_ID}
        vehicleLabel="Fiat Panda AB123CD"
        currentOwnerCustomerId={CURRENT_OWNER_ID}
      />
    </Wrapper>,
  );
  return { onOpenChange };
}

// Navigate to step 2 (Motivo) by selecting the existing customer in step 1.
async function advanceToStep2(user: ReturnType<typeof userEvent.setup>) {
  // Type in search box to trigger results display (>= 2 chars needed)
  await user.type(screen.getByPlaceholderText(/nome, cognome/i), 'Lu');
  // Click the customer result
  await user.click(screen.getByTestId('recipient-result-cust-aaa'));
}

// Navigate step 2 → step 3 (Conferma) by selecting a reason and clicking Avanti.
async function advanceToStep3(user: ReturnType<typeof userEvent.setup>) {
  // Select a reason in the mocked plain <select>
  await user.selectOptions(screen.getByTestId('reason-select'), 'purchase');
  // Click the Avanti button
  await user.click(screen.getByRole('button', { name: /avanti/i }));
}

// ---------------------------------------------------------------------------
// Setup default mocks before each test.
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockMutateAsync.mockReset();
  mockMutateAsync.mockResolvedValue({
    vehicle: { id: VEHICLE_ID, garageCode: null, plate: 'AB123CD' },
    ownership: { id: 'own-1', customerId: 'cust-aaa', startedAt: '2026-05-22T10:00:00Z' },
    transfer: {
      id: 'tr-1',
      status: 'completed',
      completedAt: '2026-05-22T10:00:00Z',
      reason: 'purchase',
      notes: null,
    },
  });
  mockUseOwnershipTransfer.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('OwnershipTransferDialog', () => {
  it('completes the 3-step wizard and submits the transfer payload', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Step 1 → 2
    await advanceToStep2(user);
    // Step 2 → 3 (Conferma)
    await advanceToStep3(user);

    // Confirm summary is shown
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /conferma trasferimento/i })).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/luca bianchi/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /conferma trasferimento/i }));

    // Assert mutateAsync called with the recipient/reason/notes payload only
    // (no documentS3Key — the upload step was removed).
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        recipient: { kind: 'existing', customerId: 'cust-aaa' },
        reason: 'purchase',
        notes: null,
      });
    });
  });
});
