import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MultiSelectPopover, type MultiSelectOption } from './MultiSelectPopover';

const OPTIONS: MultiSelectOption[] = [
  { value: 'active', label: 'Attivo' },
  { value: 'disputed', label: 'Contestato' },
  { value: 'cancelled', label: 'Cancellato' },
];

describe('MultiSelectPopover', () => {
  it('opens and adds an option to the selection', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelectPopover label="Stato" options={OPTIONS} selected={[]} onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /stato/i }));
    await userEvent.click(screen.getByText('Contestato'));

    expect(onChange).toHaveBeenCalledWith(['disputed']);
  });

  it('removes an already-selected option', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelectPopover
        label="Stato"
        options={OPTIONS}
        selected={['disputed']}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /stato/i }));
    await userEvent.click(screen.getByText('Contestato'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows the selected count on the trigger', () => {
    render(
      <MultiSelectPopover
        label="Stato"
        options={OPTIONS}
        selected={['active', 'cancelled']}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /stato/i })).toHaveTextContent('2');
  });
});
