import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { CustomerResultCard } from './CustomerResultCard';
import type { Customer } from '@/queries/types';

const PERSON: Customer = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Mario',
  lastName: 'Rossi',
  email: 'mario@example.it',
  phone: '+39 333 1234567',
  isBusiness: false,
  businessName: null,
  vatNumber: null,
  status: 'active',
};

const BUSINESS: Customer = {
  ...PERSON,
  id: '22222222-2222-4222-8222-222222222222',
  isBusiness: true,
  businessName: 'Trattoria Da Luigi',
};

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe('CustomerResultCard', () => {
  it('shows "Cognome Nome" and phone for a person', () => {
    render(wrap(<CustomerResultCard customer={PERSON} />));
    expect(screen.getByText('Rossi Mario')).toBeInTheDocument();
    expect(screen.getByText('+39 333 1234567')).toBeInTheDocument();
  });

  it('shows businessName and an "Azienda" badge for a business customer', () => {
    render(wrap(<CustomerResultCard customer={BUSINESS} />));
    expect(screen.getByText('Trattoria Da Luigi')).toBeInTheDocument();
    expect(screen.getByText('Azienda')).toBeInTheDocument();
  });

  it('shows an em-dash when phone is null', () => {
    render(wrap(<CustomerResultCard customer={{ ...PERSON, phone: null }} />));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('links to the customer detail page', () => {
    render(wrap(<CustomerResultCard customer={PERSON} />));
    const card = screen.getByRole('button');
    expect(card).toHaveAttribute('data-href', '/customers/11111111-1111-4111-8111-111111111111');
  });
});
