import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TimelineRow } from './TimelineRow';
import type { PrivateTimelineItem, ShopTimelineItem, TimelineItem } from '@/queries/types';

const SHOP_ITEM: ShopTimelineItem = {
  kind: 'shop_intervention',
  id: 'shop-1',
  intervention_date: '2025-03-15T10:00:00Z',
  odometer_km: 30200,
  type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
  title: 'Tagliando 30000 km',
  description: 'Cambio olio motore e filtro olio.\nSostituiti dischi anteriori e pastiglie.',
  parts_replaced_count: 3,
  status: 'active',
  is_disputed: false,
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

function renderRow(item: TimelineItem) {
  return render(<TimelineRow item={item} />);
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

  it('starts collapsed (aria-expanded=false)', () => {
    renderRow(SHOP_ITEM);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TimelineRow — toggle behavior', () => {
  it('toggles aria-expanded on click', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TimelineRow — expanded shop content', () => {
  it('shows description, parts count, attachments badge after expansion', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText(/Cambio olio motore/)).toBeInTheDocument();
    expect(screen.getByText('3 ricambi')).toBeInTheDocument();
    expect(screen.getByText('Con allegati (2)')).toBeInTheDocument();
  });

  it('omits parts badge when parts_replaced_count is 0', async () => {
    const user = userEvent.setup();
    const item: ShopTimelineItem = { ...SHOP_ITEM, parts_replaced_count: 0 };
    renderRow(item);
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText(/ricambi/)).not.toBeInTheDocument();
    expect(screen.getByText('Con allegati (2)')).toBeInTheDocument();
  });

  it('omits attachments badge when has_attachments is false', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED); // has_attachments: false
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText(/Con allegati/)).not.toBeInTheDocument();
    expect(screen.getByText('1 ricambi')).toBeInTheDocument();
  });

  it('shows "Nessuna descrizione." when description is empty', async () => {
    const user = userEvent.setup();
    const item: ShopTimelineItem = { ...SHOP_ITEM, description: '   ' };
    renderRow(item);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Nessuna descrizione.')).toBeInTheDocument();
  });
});

describe('TimelineRow — expanded private content', () => {
  it('shows description, no parts badge for private items', async () => {
    const user = userEvent.setup();
    renderRow(PRIVATE_ITEM);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Stagionali invernali montate.')).toBeInTheDocument();
    expect(screen.queryByText(/ricambi/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Con allegati/)).not.toBeInTheDocument();
  });
});
