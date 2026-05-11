import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AttachmentDropzone } from './AttachmentDropzone';
import type { UploadState } from '@/queries/attachmentUpload';

const noop = () => {};

beforeEach(() => {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL: vi.fn(),
  });
});

function defaultProps(overrides: Partial<React.ComponentProps<typeof AttachmentDropzone>> = {}) {
  return {
    currentCount: 0,
    state: { phase: 'idle' } as UploadState,
    onSelect: noop,
    onUpload: noop,
    onCancel: noop,
    onReset: noop,
    ...overrides,
  };
}

describe('AttachmentDropzone — rendering by state', () => {
  it('idle state shows the dropzone area + picker label', () => {
    render(<AttachmentDropzone {...defaultProps()} />);
    expect(screen.getByRole('button', { name: /trascina qui un file/i })).toBeInTheDocument();
    expect(screen.getByText(/seleziona file/i)).toBeInTheDocument();
  });

  it('count=10 hides the dropzone and shows limit message', () => {
    render(<AttachmentDropzone {...defaultProps({ currentCount: 10 })} />);
    expect(screen.queryByRole('button', { name: /trascina/i })).not.toBeInTheDocument();
    expect(screen.getByText(/limite di 10 allegati raggiunto/i)).toBeInTheDocument();
  });

  it('uploading phase shows progress bar with aria-valuenow', () => {
    render(
      <AttachmentDropzone {...defaultProps({ state: { phase: 'uploading', progress: 0.42 } })} />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('error phase shows error message in aria-live region and Riprova button', () => {
    render(
      <AttachmentDropzone
        {...defaultProps({
          state: { phase: 'error', code: 'xhr.network_error', message: 'Errore di rete' },
        })}
      />,
    );
    const region = screen.getByText('Errore di rete').closest('[aria-live]');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument();
  });
});

describe('AttachmentDropzone — pre-flight validation feedback', () => {
  it('drag&drop of file >10MB triggers inline error via onSelect callback receiving a File', async () => {
    const onSelect = vi.fn();
    render(<AttachmentDropzone {...defaultProps({ onSelect })} />);

    // Use a tiny real buffer but override `.size` via defineProperty so we
    // don't actually allocate 11 MB in JSDOM (which times out).
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

    const dropzone = screen.getByRole('button', { name: /trascina/i });
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [file],
        items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
      },
    });

    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it('drop of multiple files calls onSelect with null (rejected)', () => {
    const onSelect = vi.fn();
    render(<AttachmentDropzone {...defaultProps({ onSelect })} />);

    const f1 = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const f2 = new File(['y'], 'b.jpg', { type: 'image/jpeg' });

    const dropzone = screen.getByRole('button', { name: /trascina/i });
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [f1, f2],
        items: [
          { webkitGetAsEntry: () => ({ isDirectory: false }) },
          { webkitGetAsEntry: () => ({ isDirectory: false }) },
        ],
      },
    });

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('drop of a directory calls onSelect with null', () => {
    const onSelect = vi.fn();
    render(<AttachmentDropzone {...defaultProps({ onSelect })} />);

    const dropzone = screen.getByRole('button', { name: /trascina/i });
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [new File([], 'folder')],
        items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
      },
    });

    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('AttachmentDropzone — keyboard a11y', () => {
  it('Enter on focused dropzone triggers the picker click', async () => {
    const user = userEvent.setup();
    render(<AttachmentDropzone {...defaultProps()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(noop);

    const dropzone = screen.getByRole('button', { name: /trascina/i });
    dropzone.focus();
    await user.keyboard('{Enter}');

    expect(clickSpy).toHaveBeenCalled();
  });

  it('Space on focused dropzone triggers the picker click', async () => {
    const user = userEvent.setup();
    render(<AttachmentDropzone {...defaultProps()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(noop);

    const dropzone = screen.getByRole('button', { name: /trascina/i });
    dropzone.focus();
    await user.keyboard(' ');

    expect(clickSpy).toHaveBeenCalled();
  });
});
