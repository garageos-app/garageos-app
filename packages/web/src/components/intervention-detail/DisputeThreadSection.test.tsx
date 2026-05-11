import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoisted mock refs — must be created before any vi.mock factory runs.
// ---------------------------------------------------------------------------

const { mockDialog } = vi.hoisted(() => ({
  mockDialog:
    vi.fn<
      (props: {
        interventionId: string;
        vehicleId: string;
        interventionTitle: string;
        open: boolean;
        onOpenChange: (open: boolean) => void;
      }) => React.ReactElement | null
    >(),
}));

vi.mock('@/components/DisputeResponseDialog', () => ({
  DisputeResponseDialog: (props: Parameters<typeof mockDialog>[0]) => mockDialog(props),
}));

// ---------------------------------------------------------------------------
// Subject under test (imported after mocks are in place)
// ---------------------------------------------------------------------------

import { DisputeThreadSection } from './DisputeThreadSection';
import type { InterventionDispute } from '@/queries/types';
import React from 'react';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DISPUTE_OPEN: InterventionDispute = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  reasonCategory: 'not_performed',
  customerDescription: 'Il lavoro non risulta effettuato.',
  status: 'open',
  tenantResponse: null,
  tenantResponseAt: null,
  tenantResponseUser: null,
  createdAt: '2025-06-01T09:00:00Z',
  resolvedAt: null,
};

const DISPUTE_RESPONDED: InterventionDispute = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  reasonCategory: 'wrong_data',
  customerDescription: 'La targa indicata non corrisponde.',
  status: 'responded',
  tenantResponse: 'Abbiamo verificato: la targa è corretta.',
  tenantResponseAt: '2025-06-02T11:30:00Z',
  tenantResponseUser: { firstName: 'Mario', lastName: 'Rossi' },
  createdAt: '2025-05-28T08:00:00Z',
  resolvedAt: null,
};

const DISPUTE_RESOLVED: InterventionDispute = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  reasonCategory: 'other',
  customerDescription: 'Contestazione generica risolta.',
  status: 'resolved_by_cancellation',
  tenantResponse: null,
  tenantResponseAt: null,
  tenantResponseUser: null,
  createdAt: '2025-05-20T10:00:00Z',
  resolvedAt: '2025-05-22T15:00:00Z',
};

const BASE_PROPS = {
  interventionId: '11111111-1111-1111-1111-111111111111',
  vehicleId: '22222222-2222-2222-2222-222222222222',
  interventionTitle: 'Tagliando 30.000 km',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DisputeThreadSection', () => {
  // 1. Returns null when disputes is empty
  it('returns null when disputes list is empty', () => {
    const { container } = render(<DisputeThreadSection {...BASE_PROPS} disputes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  // 2. Renders one card per dispute with customerDescription, category badge, status badge
  it('renders one entry per dispute with description, reason label, and status label', () => {
    render(<DisputeThreadSection {...BASE_PROPS} disputes={[DISPUTE_OPEN, DISPUTE_RESPONDED]} />);

    // Customer descriptions visible
    expect(screen.getByText('Il lavoro non risulta effettuato.')).toBeInTheDocument();
    expect(screen.getByText('La targa indicata non corrisponde.')).toBeInTheDocument();

    // Reason labels from disputeReasonLabel()
    expect(screen.getByText('Lavoro non svolto')).toBeInTheDocument(); // not_performed
    expect(screen.getByText('Dati errati')).toBeInTheDocument(); // wrong_data

    // Status labels from disputeStatusLabel()
    expect(screen.getByText('Aperta')).toBeInTheDocument(); // open
    expect(screen.getByText('Risposta inviata')).toBeInTheDocument(); // responded
  });

  // 3. Renders tenantResponse block when present
  it('renders tenant response block when tenantResponse is set', () => {
    render(<DisputeThreadSection {...BASE_PROPS} disputes={[DISPUTE_RESPONDED]} />);

    // Response text visible
    expect(screen.getByText('Abbiamo verificato: la targa è corretta.')).toBeInTheDocument();

    // Responder name visible
    expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument();
  });

  // 4a. Rispondi button visible when at least one dispute is 'open' → opens dialog on click
  it('shows Rispondi button when a dispute is open and opens dialog on click', async () => {
    const user = userEvent.setup();

    mockDialog.mockReturnValue(null);

    render(<DisputeThreadSection {...BASE_PROPS} disputes={[DISPUTE_OPEN]} />);

    const btn = screen.getByRole('button', { name: 'Rispondi alla contestazione' });
    expect(btn).toBeInTheDocument();

    await user.click(btn);

    // Dialog should have been called with open=true
    const lastCall = mockDialog.mock.calls[mockDialog.mock.calls.length - 1][0];
    expect(lastCall.open).toBe(true);
    expect(lastCall.interventionId).toBe(BASE_PROPS.interventionId);
    expect(lastCall.vehicleId).toBe(BASE_PROPS.vehicleId);
    expect(lastCall.interventionTitle).toBe(BASE_PROPS.interventionTitle);
  });

  // 4b. Rispondi button absent when no dispute is 'open'
  it('hides Rispondi button when all disputes are non-open', () => {
    mockDialog.mockReturnValue(null);

    render(
      <DisputeThreadSection {...BASE_PROPS} disputes={[DISPUTE_RESPONDED, DISPUTE_RESOLVED]} />,
    );

    expect(screen.queryByRole('button', { name: 'Rispondi alla contestazione' })).toBeNull();
  });
});
