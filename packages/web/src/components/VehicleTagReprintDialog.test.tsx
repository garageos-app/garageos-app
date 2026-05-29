import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { VehicleTagReprintDialog } from './VehicleTagReprintDialog';
import { ApiError } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

// Mock Radix Dialog so portal rendering works in JSDOM.
// Pattern from DisputeResponseDialog.test.tsx.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Mock Radix Select as a plain native <select> so JSDOM can interact with it.
// The component calls onValueChange(selectedValue) — we wire that through the
// native onChange so userEvent.selectOptions works.
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
    <select aria-label="Motivo" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="" disabled>
      {placeholder}
    </option>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const VEHICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const TAG_RESPONSE = {
  tag_download_url: 'https://example.com/tags/GO-1.pdf',
  expires_at: '2026-05-30T12:00:00Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VehicleTagReprintDialog', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  // 1. Dialog default chiuso e apre via prop
  it('does not render content when open=false, renders when open=true', () => {
    const { Wrapper, qc } = makeWrapper();
    const { rerender } = render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={false} onOpenChange={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.queryByText('Ristampa tag')).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={qc}>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Ristampa tag')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  // 2. reason='Smarrito' + checkbox → submit OK → apiFetch called + onOpenChange(false)
  it('submits with reason=lost and documentVerified=true, closes dialog', async () => {
    mockApiFetch.mockResolvedValueOnce(TAG_RESPONSE);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={onOpenChange} />
      </Wrapper>,
    );

    await user.selectOptions(screen.getByRole('combobox', { hidden: true }), 'lost');
    await user.click(screen.getByRole('checkbox', { hidden: true }));
    await user.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/v1/vehicles/${VEHICLE_ID}/tag-reprint`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'lost', documentVerified: true }),
        }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 3. reason='Altro' senza note → form error + apiFetch NOT called
  it('shows validation error for reason=other without note, does not submit', async () => {
    const user = userEvent.setup();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={vi.fn()} />
      </Wrapper>,
    );

    await user.selectOptions(screen.getByRole('combobox', { hidden: true }), 'other');
    await user.click(screen.getByRole('checkbox', { hidden: true }));
    // Leave the reasonNote textarea empty (or whitespace too short)
    await user.click(screen.getByRole('button', { name: 'Conferma' }));

    expect(
      await screen.findByText('Nota obbligatoria per il motivo "Altro" (min 3 caratteri)'),
    ).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  // 4. reason='Altro' + note ≥3 chars → submit OK + body includes reasonNote
  it('submits with reason=other and reasonNote when note has ≥3 chars', async () => {
    mockApiFetch.mockResolvedValueOnce(TAG_RESPONSE);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={onOpenChange} />
      </Wrapper>,
    );

    await user.selectOptions(screen.getByRole('combobox', { hidden: true }), 'other');
    await user.type(screen.getByLabelText('Specifica nota'), 'Furto dello scoiattolo');
    await user.click(screen.getByRole('checkbox', { hidden: true }));
    await user.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/v1/vehicles/${VEHICLE_ID}/tag-reprint`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            reason: 'other',
            reasonNote: 'Furto dello scoiattolo',
            documentVerified: true,
          }),
        }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 5. checkbox unchecked → submit button disabled
  it('disables submit button when documentVerified is unchecked', async () => {
    const user = userEvent.setup();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={vi.fn()} />
      </Wrapper>,
    );

    await user.selectOptions(screen.getByRole('combobox', { hidden: true }), 'lost');
    // Do NOT check the checkbox
    expect(screen.getByRole('button', { name: 'Conferma' })).toBeDisabled();
  });

  // 6. Backend 500 → inline error visible + dialog remains open
  it('shows inline error message and keeps dialog open on backend 500', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('internal_error', 500, 'Internal server error'),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={onOpenChange} />
      </Wrapper>,
    );

    await user.selectOptions(screen.getByRole('combobox', { hidden: true }), 'damaged');
    await user.click(screen.getByRole('checkbox', { hidden: true }));
    await user.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(screen.getByText('Impossibile generare la ristampa. Riprova.')).toBeInTheDocument();
    });
    // Dialog stays open: onOpenChange(false) must NOT have been called
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // 7. Annulla button chiude senza submit
  it('closes dialog without calling apiFetch when Annulla is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <VehicleTagReprintDialog vehicleId={VEHICLE_ID} open={true} onOpenChange={onOpenChange} />
      </Wrapper>,
    );

    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
