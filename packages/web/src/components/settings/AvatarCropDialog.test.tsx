import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarCropDialog } from './AvatarCropDialog';

// Mock react-easy-crop: render a simple div + an onCropComplete trigger button
vi.mock('react-easy-crop', () => ({
  default: ({
    onCropComplete,
  }: {
    onCropComplete: (
      _: unknown,
      area: { x: number; y: number; width: number; height: number },
    ) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="sim-crop"
        onClick={() => onCropComplete({}, { x: 10, y: 20, width: 100, height: 100 })}
      >
        sim
      </button>
    </div>
  ),
}));

// Mock avatarCanvas.cropAndResize to avoid real canvas
vi.mock('@/lib/avatarCanvas', () => ({
  cropAndResize: vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' })),
}));

const onCancel = vi.fn();
const onConfirm = vi.fn();

beforeEach(() => {
  onCancel.mockReset();
  onConfirm.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AvatarCropDialog', () => {
  it('renders title when open', () => {
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    expect(screen.getByText('Ritaglia foto')).toBeInTheDocument();
  });

  it('Annulla button calls onCancel', async () => {
    const user = userEvent.setup();
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('Conferma is disabled until crop is reported', async () => {
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('button', { name: 'Conferma' })).toBeDisabled();
  });

  it('Conferma after crop calls cropAndResize and onConfirm with Blob', async () => {
    const user = userEvent.setup();
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    // Trigger the mocked onCropComplete
    await user.click(screen.getByTestId('sim-crop'));
    await user.click(screen.getByRole('button', { name: 'Conferma' }));
    // The mock returns immediately; wait for the call
    await new Promise((r) => queueMicrotask(r as () => void));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0]).toBeInstanceOf(Blob);
  });
});
