import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LocationSelector } from './LocationSelector';
import type { LocationFilterValue } from './useLocationFilter';

const filterRef = { current: {} as LocationFilterValue };
vi.mock('./useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));

const LOC_A = { id: 'loc-a', name: 'Sede A', isPrimary: true, city: 'Milano' };
const LOC_B = { id: 'loc-b', name: 'Sede B', isPrimary: false, city: 'Roma' };

describe('LocationSelector', () => {
  it('renders nothing for a mechanic', () => {
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: vi.fn(),
      locations: [],
      isSuperAdmin: false,
    };
    const { container } = render(<LocationSelector />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a super_admin with a single location', () => {
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: vi.fn(),
      locations: [LOC_A] as never,
      isSuperAdmin: true,
    };
    const { container } = render(<LocationSelector />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the selector for a super_admin with ≥2 locations', () => {
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: vi.fn(),
      locations: [LOC_A, LOC_B] as never,
      isSuperAdmin: true,
    };
    render(<LocationSelector />);
    expect(screen.getByRole('combobox', { name: /sede/i })).toBeInTheDocument();
  });

  it('selecting a sede calls setSelectedLocationId with its id', async () => {
    const setFn = vi.fn();
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: setFn,
      locations: [LOC_A, LOC_B] as never,
      isSuperAdmin: true,
    };
    const user = userEvent.setup();
    render(<LocationSelector />);
    await user.click(screen.getByRole('combobox', { name: /sede/i }));
    await user.click(await screen.findByText(/Sede B/));
    expect(setFn).toHaveBeenCalledWith('loc-b');
  });

  it('selecting "Tutte le sedi" calls setSelectedLocationId with null', async () => {
    const setFn = vi.fn();
    filterRef.current = {
      selectedLocationId: 'loc-b',
      setSelectedLocationId: setFn,
      locations: [LOC_A, LOC_B] as never,
      isSuperAdmin: true,
    };
    const user = userEvent.setup();
    render(<LocationSelector />);
    await user.click(screen.getByRole('combobox', { name: /sede/i }));
    await user.click(await screen.findByText(/Tutte le sedi/));
    expect(setFn).toHaveBeenCalledWith(null);
  });
});
