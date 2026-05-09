import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { DeadlineRow } from './DeadlineRow';
import type { TenantDeadline, TenantDeadlineCustomer } from '@/queries/types';

const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';

const VISIBLE_CUSTOMER: TenantDeadlineCustomer = {
  id: 'cust-1',
  firstName: 'Mario',
  lastName: 'Rossi',
  email: 'mario@example.it',
  phone: null,
  isBusiness: false,
  businessName: null,
  vatNumber: null,
};

const REDACTED_CUSTOMER: TenantDeadlineCustomer = {
  id: 'cust-2',
  firstName: null,
  lastName: null,
  email: null,
  phone: null,
  isBusiness: null,
  businessName: null,
  vatNumber: null,
};

function makeDeadline(overrides: Partial<TenantDeadline>): TenantDeadline {
  // Use 'dueDate' in overrides to distinguish explicit null from "not provided",
  // because `null ?? default` would silently fall back to the default otherwise.
  const dueDate =
    'dueDate' in overrides ? (overrides.dueDate as string | null) : '2025-08-15T00:00:00Z';
  const currentOwnership =
    overrides.vehicle !== undefined
      ? overrides.vehicle.currentOwnership
      : { customer: VISIBLE_CUSTOMER };

  return {
    id: 'd1',
    vehicleId: VEHICLE_ID,
    interventionTypeId: 't1',
    dueDate,
    dueOdometerKm: overrides.dueOdometerKm ?? null,
    description: null,
    isRecurring: false,
    status: 'open',
    vehicle: {
      id: VEHICLE_ID,
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership,
    },
    interventionType: { id: 't1', code: 'TAGLIANDO', nameIt: 'Tagliando' },
  };
}

function renderRow(item: TenantDeadline) {
  return render(
    <MemoryRouter>
      <DeadlineRow item={item} />
    </MemoryRouter>,
  );
}

describe('DeadlineRow', () => {
  it('renders vehicle make/model + plate + intervention type + dueDate + customer name', () => {
    renderRow(makeDeadline({}));
    expect(screen.getByText(/Fiat Panda/)).toBeInTheDocument();
    expect(screen.getByText('AB123CD')).toBeInTheDocument();
    expect(screen.getByText('Tagliando')).toBeInTheDocument();
    expect(screen.getByText(/15\/08\/2025/)).toBeInTheDocument();
    expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument();
  });

  it('shows "—" when customer is redacted (PII)', () => {
    const d = makeDeadline({
      vehicle: {
        id: VEHICLE_ID,
        plate: 'AB123CD',
        make: 'Fiat',
        model: 'Panda',
        currentOwnership: { customer: REDACTED_CUSTOMER },
      },
    });
    renderRow(d);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/Mario Rossi/)).not.toBeInTheDocument();
  });

  it('shows "—" when there is no current ownership', () => {
    const d = makeDeadline({
      vehicle: {
        id: VEHICLE_ID,
        plate: 'AB123CD',
        make: 'Fiat',
        model: 'Panda',
        currentOwnership: null,
      },
    });
    renderRow(d);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows km target when dueDate is null and dueOdometerKm is set', () => {
    const d = makeDeadline({ dueDate: null, dueOdometerKm: 30000 });
    renderRow(d);
    expect(screen.getByText(/30\.000 km/)).toBeInTheDocument();
  });

  it('vehicle area links to /vehicles/:id', () => {
    renderRow(makeDeadline({}));
    const vehicleLink = screen.getByRole('link', { name: /Fiat Panda/ });
    expect(vehicleLink).toHaveAttribute('href', `/vehicles/${VEHICLE_ID}`);
  });

  it('customer name links to /customers/:id when visible (closes followup #80)', () => {
    renderRow(makeDeadline({}));
    const customerLink = screen.getByRole('link', { name: /Mario Rossi/ });
    expect(customerLink).toHaveAttribute('href', `/customers/${VISIBLE_CUSTOMER.id}`);
  });

  it('does NOT render customer link when redacted', () => {
    const d = makeDeadline({
      vehicle: {
        id: VEHICLE_ID,
        plate: 'AB123CD',
        make: 'Fiat',
        model: 'Panda',
        currentOwnership: { customer: REDACTED_CUSTOMER },
      },
    });
    renderRow(d);
    // No customer link present (redacted = "—" plain text only). The vehicle
    // link still exists; ensure no other link slipped through.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/vehicles/${VEHICLE_ID}`);
  });
});
