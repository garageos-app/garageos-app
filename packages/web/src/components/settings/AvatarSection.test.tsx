import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarSection } from './AvatarSection';
import type { ProfileMeDto } from '@/queries/profileMe';

// Mock toast
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Mock the hook
const uploadMock = vi.fn();
const removeMock = vi.fn();
const resetMock = vi.fn();
const hookStateRef = { current: { phase: 'idle' as const } };
vi.mock('@/queries/avatarUpload', () => ({
  useAvatarUpload: () => ({
    upload: uploadMock,
    remove: removeMock,
    reset: resetMock,
    get state() {
      return hookStateRef.current;
    },
  }),
}));

// Mock crop dialog — render a button that fires onConfirm with a Blob
vi.mock('./AvatarCropDialog', () => ({
  AvatarCropDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (b: Blob) => void }) =>
    open ? (
      <button data-testid="sim-crop-confirm" onClick={() => onConfirm(new Blob(['x']))}>
        sim-crop-confirm
      </button>
    ) : null,
}));

const baseProfile: ProfileMeDto = {
  id: 'u1',
  email: 'a@b.c',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  tenantId: 't1',
  locationId: null,
  avatarUrl: null,
  phone: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  uploadMock.mockReset();
  removeMock.mockReset();
  hookStateRef.current = { phase: 'idle' };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AvatarSection', () => {
  it('renders initials when avatarUrl is null', () => {
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    expect(screen.getByLabelText('Iniziali profilo')).toHaveTextContent('MR');
  });

  it('renders <img> when avatarUrl is set', () => {
    render(<AvatarSection profile={{ ...baseProfile, avatarUrl: 'https://signed' }} />, {
      wrapper,
    });
    expect(screen.getByAltText('Foto profilo')).toHaveAttribute('src', 'https://signed');
  });

  it('does NOT render Rimuovi button when no avatar', () => {
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    expect(screen.queryByRole('button', { name: 'Rimuovi' })).not.toBeInTheDocument();
  });

  it('renders Rimuovi button when avatar present', () => {
    render(<AvatarSection profile={{ ...baseProfile, avatarUrl: 'https://signed' }} />, {
      wrapper,
    });
    expect(screen.getByRole('button', { name: 'Rimuovi' })).toBeInTheDocument();
  });

  it('file picker → invalid mime → toast error, hook NOT called', async () => {
    const { toast } = await import('sonner');
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const badFile = new File(['x'], 'a.txt', { type: 'text/plain' });
    // Pass applyAccept:false so userEvent doesn't filter the file before onChange fires;
    // the component's own MIME guard must reject it and call toast.error.
    await userEvent.upload(input, badFile, { applyAccept: false });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Formato non supportato/));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('file picker → oversized → toast error', async () => {
    const { toast } = await import('sonner');
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], 'a.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, bigFile);
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/troppo grande/));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('file picker → valid → opens crop dialog → confirm calls upload', async () => {
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const goodFile = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, goodFile);
    // crop dialog now open (mock renders sim-crop-confirm)
    const simButton = await screen.findByTestId('sim-crop-confirm');
    await userEvent.click(simButton);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0]![0]).toBeInstanceOf(Blob);
  });

  it('Rimuovi → AlertDialog → conferma calls remove', async () => {
    render(<AvatarSection profile={{ ...baseProfile, avatarUrl: 'https://signed' }} />, {
      wrapper,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sì, rimuovi' }));
    expect(removeMock).toHaveBeenCalled();
  });

  it('renders upload progress when phase=uploading', () => {
    hookStateRef.current = { phase: 'uploading', progress: 0.42 } as never;
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    expect(screen.getByText(/Caricamento: 42%/)).toBeInTheDocument();
  });
});
