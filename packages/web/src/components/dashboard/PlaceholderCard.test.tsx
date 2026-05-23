import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceholderCard } from './PlaceholderCard';

describe('<PlaceholderCard />', () => {
  it('renders the title', () => {
    render(<PlaceholderCard title="Ultimi interventi" />);
    expect(screen.getByText('Ultimi interventi')).toBeInTheDocument();
  });

  it('renders the "in arrivo" label', () => {
    render(<PlaceholderCard title="Contestazioni" />);
    expect(screen.getByText('In arrivo nel prossimo PR')).toBeInTheDocument();
  });

  it('renders 3 skeleton rows for visual density', () => {
    const { container } = render(<PlaceholderCard title="x" />);
    expect(container.querySelectorAll('[data-testid="placeholder-skeleton-row"]').length).toBe(3);
  });
});
