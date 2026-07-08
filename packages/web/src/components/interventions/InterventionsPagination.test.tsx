import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InterventionsPagination } from './InterventionsPagination';

describe('InterventionsPagination', () => {
  it('disables prev on the first page and advances on next', async () => {
    const onPageChange = vi.fn();
    render(<InterventionsPagination page={1} total={60} onPageChange={onPageChange} />);

    expect(screen.getByText(/pagina 1 di 3/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /precedente/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /successiva/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('disables next on the last page', () => {
    render(<InterventionsPagination page={3} total={60} onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /successiva/i })).toBeDisabled();
  });
});
