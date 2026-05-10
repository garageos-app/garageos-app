import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DisputeRespondedCard } from './DisputeRespondedCard';
import type { InterventionDispute } from '@/queries/types';

const baseDispute: InterventionDispute = {
  id: 'd1',
  reasonCategory: 'wrong_data',
  customerDescription: 'Targa veicolo errata sul documento.',
  status: 'responded',
  tenantResponse: 'Verificato e corretto. Documento aggiornato.',
  tenantResponseAt: '2026-04-15T10:30:00.000Z',
  tenantResponseUser: { firstName: 'Mario', lastName: 'Rossi' },
  createdAt: '2026-04-10T08:00:00.000Z',
  resolvedAt: null,
};

describe('DisputeRespondedCard — responded status', () => {
  it('renders customer description, reason badge, status badge, response section with author', () => {
    render(<DisputeRespondedCard dispute={baseDispute} />);
    expect(screen.getByText('Targa veicolo errata sul documento.')).toBeInTheDocument();
    expect(screen.getByText('Dati errati')).toBeInTheDocument();
    expect(screen.getByText('Risposta inviata')).toBeInTheDocument();
    expect(screen.getByText('Verificato e corretto. Documento aggiornato.')).toBeInTheDocument();
    expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument();
  });

  it('omits author chunk when tenantResponseUser is null', () => {
    render(<DisputeRespondedCard dispute={{ ...baseDispute, tenantResponseUser: null }} />);
    expect(screen.getByText('Verificato e corretto. Documento aggiornato.')).toBeInTheDocument();
    expect(screen.queryByText(/Mario Rossi/)).not.toBeInTheDocument();
  });
});

describe('DisputeRespondedCard — non-responded statuses', () => {
  it('renders the cancellation note for resolved_by_cancellation', () => {
    render(
      <DisputeRespondedCard
        dispute={{
          ...baseDispute,
          status: 'resolved_by_cancellation',
          tenantResponse: null,
          tenantResponseAt: null,
          tenantResponseUser: null,
          resolvedAt: '2026-04-20T12:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByText('Chiusa per cancellazione intervento')).toBeInTheDocument();
    expect(
      screen.getByText(/Intervento cancellato — la contestazione è stata chiusa di conseguenza./),
    ).toBeInTheDocument();
  });

  it('renders the admin-handled note for escalated', () => {
    render(
      <DisputeRespondedCard
        dispute={{
          ...baseDispute,
          status: 'escalated',
          tenantResponse: null,
          tenantResponseAt: null,
          tenantResponseUser: null,
        }}
      />,
    );
    expect(screen.getByText('Escalation in corso')).toBeInTheDocument();
    expect(screen.getByText(/Gestita dall'amministrazione GarageOS./)).toBeInTheDocument();
  });

  it('renders the admin-handled note for closed_by_admin', () => {
    render(
      <DisputeRespondedCard
        dispute={{
          ...baseDispute,
          status: 'closed_by_admin',
          tenantResponse: null,
          tenantResponseAt: null,
          tenantResponseUser: null,
        }}
      />,
    );
    expect(screen.getByText(/Chiusa dall'amministrazione/)).toBeInTheDocument();
    expect(screen.getByText(/Gestita dall'amministrazione GarageOS./)).toBeInTheDocument();
  });
});
