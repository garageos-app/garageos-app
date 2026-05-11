import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { TimelineRow } from './TimelineRow';
import type { PrivateTimelineItem, ShopTimelineItem, TimelineItem } from '@/queries/types';

// Mock the Dialog so we can assert its open state without rendering portal.
vi.mock('./DisputeResponseDialog', () => ({
  DisputeResponseDialog: ({
    open,
    interventionId,
    vehicleId,
  }: {
    open: boolean;
    interventionId: string;
    vehicleId: string;
  }) => (open ? <div data-testid={`dialog-open-${interventionId}-${vehicleId}`} /> : null),
}));

const SHOP_ITEM: ShopTimelineItem = {
  kind: 'shop_intervention',
  id: 'shop-1',
  intervention_date: '2025-03-15T10:00:00Z',
  odometer_km: 30200,
  type: { id: 'type-tagliando', code: 'TAGLIANDO', name_it: 'Tagliando' },
  title: 'Tagliando 30000 km',
  description: 'Cambio olio motore e filtro olio.\nSostituiti dischi anteriori e pastiglie.',
  parts_replaced_count: 3,
  status: 'active',
  is_disputed: false,
  wiki_locked_at: null,
  tenant: { business_name: 'Officina Rossi', location_city: 'Milano' },
  has_attachments: true,
  attachments_count: 2,
};

const SHOP_ITEM_DISPUTED: ShopTimelineItem = {
  ...SHOP_ITEM,
  id: 'shop-disputed',
  is_disputed: true,
  title: 'Cambio frizione',
  description: 'Sostituzione frizione completa.',
  parts_replaced_count: 1,
  has_attachments: false,
  attachments_count: 0,
};

const PRIVATE_ITEM: PrivateTimelineItem = {
  kind: 'private_intervention',
  id: 'private-1',
  intervention_date: '2025-02-10T08:00:00Z',
  odometer_km: 28100,
  custom_type: 'Cambio gomme',
  description: 'Stagionali invernali montate.',
  has_attachments: false,
  attachments_count: 0,
};

function renderRow(item: TimelineItem, vehicleId = 'veh-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return render(
    <Wrapper>
      <TimelineRow item={item} vehicleId={vehicleId} />
    </Wrapper>,
  );
}

describe('TimelineRow — compact rendering', () => {
  it('renders shop row with title, subtitle, kind badge, no dispute', () => {
    renderRow(SHOP_ITEM);
    expect(screen.getByText('Tagliando 30000 km')).toBeInTheDocument();
    expect(screen.getByText(/Officina Rossi.*Milano/)).toBeInTheDocument();
    expect(screen.getByText('Officina')).toBeInTheDocument();
    expect(screen.queryByText('Disputa')).not.toBeInTheDocument();
  });

  it('renders private row with custom_type as title and "Cliente" subtitle', () => {
    renderRow(PRIVATE_ITEM);
    expect(screen.getByText('Cambio gomme')).toBeInTheDocument();
    expect(screen.getByText(/Cliente/)).toBeInTheDocument();
    expect(screen.getByText('Privato')).toBeInTheDocument();
  });

  it('shows Disputa badge in compact when shop is_disputed=true', () => {
    renderRow(SHOP_ITEM_DISPUTED);
    expect(screen.getByText('Disputa')).toBeInTheDocument();
  });

  it('starts collapsed (chevron toggle aria-expanded=false)', () => {
    renderRow(SHOP_ITEM);
    const chevron = screen.getByRole('button', { name: 'Espandi dettagli intervento' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TimelineRow — toggle behavior', () => {
  it('toggles via chevron button', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    const chevron = screen.getByRole('button', { name: 'Espandi dettagli intervento' });

    await user.click(chevron);
    expect(screen.getByRole('button', { name: 'Comprimi dettagli intervento' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Comprimi dettagli intervento' }));
    expect(screen.getByRole('button', { name: 'Espandi dettagli intervento' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('toggles via row body click (not the dispute badge)', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED);
    // The row body button is the one with the title text inside
    const rowBody = screen.getByText('Cambio frizione').closest('button')!;
    // Before click: chevron shows 'Espandi' (collapsed)
    expect(screen.getByRole('button', { name: 'Espandi dettagli intervento' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await user.click(rowBody);
    // After click: chevron shows 'Comprimi' (expanded)
    expect(screen.getByRole('button', { name: 'Comprimi dettagli intervento' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('TimelineRow — expanded shop content', () => {
  it('shows description, parts count, attachments badge after expansion', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.getByText(/Cambio olio motore/)).toBeInTheDocument();
    expect(screen.getByText('3 ricambi')).toBeInTheDocument();
    expect(screen.getByText('Con allegati (2)')).toBeInTheDocument();
  });

  it('omits parts badge when parts_replaced_count is 0', async () => {
    const user = userEvent.setup();
    const item: ShopTimelineItem = { ...SHOP_ITEM, parts_replaced_count: 0 };
    renderRow(item);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.queryByText(/ricambi/)).not.toBeInTheDocument();
    expect(screen.getByText('Con allegati (2)')).toBeInTheDocument();
  });

  it('omits attachments badge when has_attachments is false', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED); // has_attachments: false
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.queryByText(/Con allegati/)).not.toBeInTheDocument();
    expect(screen.getByText('1 ricambi')).toBeInTheDocument();
  });

  it('shows "Nessuna descrizione." when description is empty', async () => {
    const user = userEvent.setup();
    const item: ShopTimelineItem = { ...SHOP_ITEM, description: '   ' };
    renderRow(item);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.getByText('Nessuna descrizione.')).toBeInTheDocument();
  });
});

describe('TimelineRow — expanded private content', () => {
  it('shows description, no parts badge for private items', async () => {
    const user = userEvent.setup();
    renderRow(PRIVATE_ITEM);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.getByText('Stagionali invernali montate.')).toBeInTheDocument();
    expect(screen.queryByText(/ricambi/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Con allegati/)).not.toBeInTheDocument();
  });
});

describe('TimelineRow — dispute dialog wiring', () => {
  it('does not render the dialog when not disputed', () => {
    renderRow(SHOP_ITEM);
    expect(screen.queryByTestId(/^dialog-open/)).not.toBeInTheDocument();
  });

  it('opens the DisputeResponseDialog when clicking the Disputa badge', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED, 'veh-42');
    expect(screen.queryByTestId(/^dialog-open/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Apri contestazione/ }));
    expect(screen.getByTestId('dialog-open-shop-disputed-veh-42')).toBeInTheDocument();
  });

  it('clicking the dispute badge does not toggle the row expansion', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED);
    await user.click(screen.getByRole('button', { name: /Apri contestazione/ }));
    // Chevron button should still report collapsed (row NOT expanded)
    expect(screen.getByRole('button', { name: 'Espandi dettagli intervento' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
