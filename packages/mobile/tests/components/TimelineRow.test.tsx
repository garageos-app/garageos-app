import { fireEvent, render, screen } from '@testing-library/react-native';
import { TimelineRow } from '@/components/TimelineRow';
import type { TimelineItem } from '@/lib/types/vehicle';

const shopItem: TimelineItem = {
  kind: 'shop_intervention',
  id: 'i1',
  intervention_date: '2026-05-10',
  odometer_km: 125000,
  type: { id: 't1', code: 'oil_change', name_it: 'Cambio olio' },
  title: 'Cambio olio motore',
  description: 'Olio sintetico 5W30',
  parts_replaced_count: 2,
  status: 'completed',
  is_disputed: false,
  wiki_window_open: false,
  tenant: { business_name: 'Autofficina Rossi', location_city: 'Roma' },
  has_attachments: true,
  attachments_count: 3,
};

const privateItem: TimelineItem = {
  kind: 'private_intervention',
  id: 'p1',
  intervention_date: '2026-04-01',
  odometer_km: 120000,
  custom_type: 'Pulizia interna',
  description: null,
  has_attachments: false,
  attachments_count: 0,
};

describe('TimelineRow', () => {
  it('renders Certificato badge for shop_intervention', () => {
    render(<TimelineRow item={shopItem} />);
    expect(screen.getByText('Certificato')).toBeOnTheScreen();
  });

  it('renders Privato badge for private_intervention', () => {
    render(<TimelineRow item={privateItem} />);
    expect(screen.getByText('Privato')).toBeOnTheScreen();
    expect(screen.queryByText('Certificato')).toBeNull();
  });

  it('renders tenant business name for shop', () => {
    render(<TimelineRow item={shopItem} />);
    expect(screen.getByText('Autofficina Rossi')).toBeOnTheScreen();
  });

  it('renders custom_type for private', () => {
    render(<TimelineRow item={privateItem} />);
    expect(screen.getByText('Pulizia interna')).toBeOnTheScreen();
  });

  it('renders parts count when > 0', () => {
    render(<TimelineRow item={shopItem} />);
    expect(screen.getByText(/2 pezzi/)).toBeOnTheScreen();
  });

  it('does not crash with null description', () => {
    expect(() => render(<TimelineRow item={privateItem} />)).not.toThrow();
  });

  it('fires onPress when provided and tapped', () => {
    const onPress = jest.fn();
    render(<TimelineRow item={privateItem} onPress={onPress} />);
    fireEvent.press(screen.getByText('Pulizia interna'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders without onPress (non-interactive)', () => {
    expect(() => render(<TimelineRow item={shopItem} />)).not.toThrow();
  });
});
