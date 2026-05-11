import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Hoisted mock refs
// ---------------------------------------------------------------------------

const { mockViewMutateAsync, mockUpload, mockReset, mockToastError, mockToastSuccess } = vi.hoisted(
  () => ({
    mockViewMutateAsync: vi.fn<(id: string) => Promise<{ url: string; expires_at: string }>>(),
    mockUpload: vi.fn<(file: File) => Promise<void>>(),
    mockReset: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
  }),
);

let mockUploadState:
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'confirming' }
  | { phase: 'success'; attachmentId: string }
  | { phase: 'error'; code: string; message: string } = { phase: 'idle' };

vi.mock('@/queries/interventionDetail', () => ({
  useAttachmentViewUrl: () => ({ mutateAsync: mockViewMutateAsync }),
}));

vi.mock('@/queries/attachmentUpload', () => ({
  useAttachmentUpload: () => ({
    upload: mockUpload,
    state: mockUploadState,
    reset: mockReset,
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: mockToastSuccess },
}));

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:mock'),
  revokeObjectURL: vi.fn(),
});

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { AttachmentsSection } from './AttachmentsSection';
import type { InterventionAttachment } from '@/queries/types';

const INTERVENTION_ID = '11111111-1111-1111-1111-111111111111';

const ATT_1: InterventionAttachment = {
  id: '21111111-1111-1111-1111-111111111111',
  file_name: 'fattura-2025-06.pdf',
  mime_type: 'application/pdf',
  size_bytes: 204800,
  created_at: '2025-06-01T09:00:00Z',
};

const ATT_2: InterventionAttachment = {
  id: '22222222-2222-2222-2222-222222222222',
  file_name: 'foto-motore.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 1572864,
  created_at: '2025-07-15T14:30:00Z',
};

function tenAttachments(): InterventionAttachment[] {
  return Array.from({ length: 10 }, (_, i) => ({
    ...ATT_1,
    id: `${(i + 1).toString().padStart(8, '0')}-1111-1111-1111-111111111111`,
    file_name: `file-${i}.pdf`,
  }));
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

beforeEach(() => {
  mockViewMutateAsync.mockReset();
  mockUpload.mockReset();
  mockReset.mockReset();
  mockToastError.mockReset();
  mockToastSuccess.mockReset();
  mockUploadState = { phase: 'idle' };
  mockViewMutateAsync.mockResolvedValue({
    url: 'https://s3.example.com/file',
    expires_at: '2025-06-01T10:00:00Z',
  });
});

describe('AttachmentsSection — empty state (REGRESSION post #86)', () => {
  it('renders the card with dropzone even when attachments list is empty', () => {
    render(<AttachmentsSection attachments={[]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    expect(screen.getByText('Allegati (0/10)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /trascina/i })).toBeInTheDocument();
  });
});

describe('AttachmentsSection — list rendering (preserved from previous behavior)', () => {
  it('renders one row per attachment with file_name, formatted size, and date', () => {
    render(<AttachmentsSection attachments={[ATT_1, ATT_2]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    expect(screen.getByText('Allegati (2/10)')).toBeInTheDocument();
    expect(screen.getByText('fattura-2025-06.pdf')).toBeInTheDocument();
    expect(screen.getByText('foto-motore.jpg')).toBeInTheDocument();
    expect(screen.getByText(/200 KB/)).toBeInTheDocument();
    expect(screen.getByText(/1\.5 MB/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mostra' })).toHaveLength(2);
  });

  it('click Mostra triggers lazy presign and opens URL in new tab', async () => {
    const user = userEvent.setup();
    mockViewMutateAsync.mockResolvedValue({
      url: 'https://s3/x',
      expires_at: '2025-06-01T10:00:00Z',
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<AttachmentsSection attachments={[ATT_1, ATT_2]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    const [first] = screen.getAllByRole('button', { name: 'Mostra' });
    await user.click(first);

    expect(mockViewMutateAsync).toHaveBeenCalledWith(ATT_1.id);
    expect(openSpy).toHaveBeenCalledWith('https://s3/x', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('shows view-url error toast on Mostra failure', async () => {
    const user = userEvent.setup();
    mockViewMutateAsync.mockRejectedValue(new Error('boom'));

    render(<AttachmentsSection attachments={[ATT_1]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    await user.click(screen.getByRole('button', { name: 'Mostra' }));
    expect(mockToastError).toHaveBeenCalledWith("Impossibile aprire l'allegato.");
  });
});

describe('AttachmentsSection — upload composition', () => {
  it('header shows "N/10" counter', () => {
    render(<AttachmentsSection attachments={[ATT_1, ATT_2]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.getByText('Allegati (2/10)')).toBeInTheDocument();
  });

  it('count = 10 hides the dropzone and shows limit message', () => {
    render(<AttachmentsSection attachments={tenAttachments()} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    expect(screen.queryByRole('button', { name: /trascina/i })).not.toBeInTheDocument();
    expect(screen.getByText(/limite di 10 allegati raggiunto/i)).toBeInTheDocument();
  });

  it('pre-flight rejects file >10MB with inline validation message', async () => {
    const user = userEvent.setup();
    render(<AttachmentsSection attachments={[]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    // Use a 1-byte file with overridden size to avoid JSDOM OOM on 11MB Uint8Array.
    const file = new File([new Uint8Array(1)], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    expect(screen.getByText(/file troppo grande/i)).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('valid file → click Carica calls hook.upload with the File', async () => {
    const user = userEvent.setup();
    render(<AttachmentsSection attachments={[]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });

    const file = new File([new Uint8Array(1024)], 'foto.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    await user.click(screen.getByRole('button', { name: /carica/i }));
    expect(mockUpload).toHaveBeenCalledWith(file);
  });

  it('success state triggers success toast', async () => {
    mockUploadState = { phase: 'success', attachmentId: 'whatever' };
    render(<AttachmentsSection attachments={[]} interventionId={INTERVENTION_ID} />, {
      wrapper: makeWrapper(),
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Allegato caricato');
  });
});
