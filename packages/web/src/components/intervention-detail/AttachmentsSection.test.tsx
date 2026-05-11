import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoisted mock refs — must be created before any vi.mock factory runs.
// ---------------------------------------------------------------------------

const { mockMutateAsync, mockToastError } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn<(id: string) => Promise<{ url: string; expires_at: string }>>(),
  mockToastError: vi.fn(),
}));

vi.mock('@/queries/interventionDetail', () => ({
  useAttachmentViewUrl: () => ({ mutateAsync: mockMutateAsync }),
}));

vi.mock('sonner', () => ({
  toast: { error: mockToastError },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported after mocks are in place)
// ---------------------------------------------------------------------------

import { AttachmentsSection } from './AttachmentsSection';
import type { InterventionAttachment } from '@/queries/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATT_1: InterventionAttachment = {
  id: '11111111-1111-1111-1111-111111111111',
  file_name: 'fattura-2025-06.pdf',
  mime_type: 'application/pdf',
  size_bytes: 204800, // 200 KB
  created_at: '2025-06-01T09:00:00Z',
};

const ATT_2: InterventionAttachment = {
  id: '22222222-2222-2222-2222-222222222222',
  file_name: 'foto-motore.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 1572864, // ~1.5 MB
  created_at: '2025-07-15T14:30:00Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AttachmentsSection', () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockToastError.mockReset();

    // Default: happy path resolves with a URL
    mockMutateAsync.mockResolvedValue({
      url: 'https://s3.example.com/file',
      expires_at: '2025-06-01T10:00:00Z',
    });
  });

  // 1. Empty list → renders nothing
  it('returns null when attachments list is empty', () => {
    const { container } = render(<AttachmentsSection attachments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  // 2. Renders rows with filename, formatted size and date
  it('renders one row per attachment with file_name, formatted size, and date', () => {
    render(<AttachmentsSection attachments={[ATT_1, ATT_2]} />);

    // Card title with count
    expect(screen.getByText('Allegati (2)')).toBeInTheDocument();

    // File names
    expect(screen.getByText('fattura-2025-06.pdf')).toBeInTheDocument();
    expect(screen.getByText('foto-motore.jpg')).toBeInTheDocument();

    // Formatted sizes — 204800 bytes = 200 KB, 1572864 bytes = 1.5 MB
    expect(screen.getByText(/200 KB/)).toBeInTheDocument();
    expect(screen.getByText(/1\.5 MB/)).toBeInTheDocument();

    // Two idle Mostra buttons
    const mostraButtons = screen.getAllByRole('button', { name: 'Mostra' });
    expect(mostraButtons).toHaveLength(2);
  });

  // 3. Click Mostra → mutateAsync called with attachment id → window.open new tab
  it('click Mostra triggers lazy presign and opens URL in new tab', async () => {
    const user = userEvent.setup();

    mockMutateAsync.mockResolvedValue({
      url: 'https://s3/x',
      expires_at: '2025-06-01T10:00:00Z',
    });

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<AttachmentsSection attachments={[ATT_1, ATT_2]} />);

    const [firstMostra] = screen.getAllByRole('button', { name: 'Mostra' });
    await user.click(firstMostra);

    expect(mockMutateAsync).toHaveBeenCalledWith(ATT_1.id);
    expect(openSpy).toHaveBeenCalledWith('https://s3/x', '_blank', 'noopener,noreferrer');

    openSpy.mockRestore();
  });

  // 4. Per-row spinner — only the clicked row becomes busy; the other stays idle
  it('shows spinner only on clicked row while fetch is pending', async () => {
    const user = userEvent.setup();

    // Row 0 click → never resolves (keeps busy state)
    mockMutateAsync.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    render(<AttachmentsSection attachments={[ATT_1, ATT_2]} />);

    const [row0Button, row1Button] = screen.getAllByRole('button', { name: 'Mostra' });

    await user.click(row0Button);

    // Row 0 is busy
    expect(screen.getByRole('button', { name: 'Apertura…' })).toBeDisabled();

    // Row 1 is still idle
    expect(row1Button).toHaveTextContent('Mostra');
    expect(row1Button).not.toBeDisabled();
  });

  // 5. Mutation error → toast.error called + button resets to idle
  it('shows toast.error on mutation failure and resets button to idle', async () => {
    const user = userEvent.setup();

    mockMutateAsync.mockRejectedValue(new Error('Network error'));

    render(<AttachmentsSection attachments={[ATT_1]} />);

    const mostraButton = screen.getByRole('button', { name: 'Mostra' });
    await user.click(mostraButton);

    expect(mockToastError).toHaveBeenCalledWith("Impossibile aprire l'allegato.");

    // Button must be back to idle after finally block
    expect(screen.getByRole('button', { name: 'Mostra' })).not.toBeDisabled();
  });
});
