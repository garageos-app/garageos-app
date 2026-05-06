import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KmConfirmDialog } from './KmConfirmDialog';

describe('KmConfirmDialog', () => {
  it('renders message + 2 CTA when open', () => {
    render(
      <KmConfirmDialog
        open
        message="Km inferiori al massimo storico (52.000)."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/52\.000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /correggi/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conferma e salva/i })).toBeInTheDocument();
  });

  it('calls onConfirm when "Conferma e salva" clicked', async () => {
    const onConfirm = vi.fn();
    render(<KmConfirmDialog open message="x" onConfirm={onConfirm} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /conferma e salva/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when "Correggi" clicked', async () => {
    const onCancel = vi.fn();
    render(<KmConfirmDialog open message="x" onConfirm={() => {}} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /correggi/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
