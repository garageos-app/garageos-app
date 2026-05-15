import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { getInitials } from '@/lib/initials';
import type { ProfileMeDto } from '@/queries/profileMe';
import { useAvatarUpload } from '@/queries/avatarUpload';
import { AvatarCropDialog } from './AvatarCropDialog';

const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

interface Props {
  profile: ProfileMeDto;
}

// AvatarSection renders the current avatar (or initials fallback),
// a "Cambia foto" button (file picker → crop dialog → upload), and
// a "Rimuovi" button (with AlertDialog confirmation) when an avatar
// is already set. State machine + S3 orchestration lives in
// useAvatarUpload — this component is presentation + glue.
export function AvatarSection({ profile }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { upload, remove, state, reset } = useAvatarUpload();

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so selecting the same file twice retriggers
    if (!file) return;

    if (!ACCEPTED_MIMES.includes(file.type)) {
      toast.error('Formato non supportato. Usa JPEG, PNG o WebP.');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      toast.error('File troppo grande. Massimo 5 MB.');
      return;
    }

    const url = URL.createObjectURL(file);
    setImageSrc(url);
    setCropOpen(true);
  }

  async function handleCropConfirm(blob: Blob) {
    setCropOpen(false);
    if (imageSrc) {
      URL.revokeObjectURL(imageSrc);
      setImageSrc(null);
    }
    const result = await upload(blob);
    if (result.ok) {
      toast.success('Foto profilo aggiornata.');
    } else {
      toast.error(result.message);
    }
    reset();
  }

  function handleCropCancel() {
    setCropOpen(false);
    if (imageSrc) {
      URL.revokeObjectURL(imageSrc);
      setImageSrc(null);
    }
  }

  async function handleRemoveConfirm() {
    setRemoveOpen(false);
    const result = await remove();
    if (result.ok) {
      toast.success('Foto profilo rimossa.');
    } else {
      toast.error(result.message);
    }
    reset();
  }

  const initials = getInitials(profile.firstName, profile.lastName);
  const isBusy =
    state.phase === 'requesting' || state.phase === 'uploading' || state.phase === 'confirming';

  return (
    <div className="flex items-center gap-4 mb-6">
      {profile.avatarUrl ? (
        <img
          src={profile.avatarUrl}
          alt="Foto profilo"
          className="w-24 h-24 rounded-full object-cover bg-muted"
        />
      ) : (
        <div
          aria-label="Iniziali profilo"
          className="w-24 h-24 rounded-full bg-muted flex items-center justify-center text-2xl font-semibold"
        >
          {initials}
        </div>
      )}
      <div className="space-y-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={handleFileSelect}
          data-testid="avatar-file-input"
        />
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={isBusy}
          >
            {isBusy ? 'Caricamento...' : 'Cambia foto'}
          </Button>
          {profile.avatarUrl && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRemoveOpen(true)}
              disabled={isBusy}
            >
              Rimuovi
            </Button>
          )}
        </div>
        {state.phase === 'uploading' && (
          <div className="text-xs text-muted-foreground">
            Caricamento: {Math.round(state.progress * 100)}%
          </div>
        )}
      </div>

      <AvatarCropDialog
        open={cropOpen}
        imageSrc={imageSrc}
        onCancel={handleCropCancel}
        onConfirm={handleCropConfirm}
      />

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rimuovere foto profilo?</AlertDialogTitle>
            <AlertDialogDescription>
              La foto verrà eliminata. Tornerai alle iniziali come fallback.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveConfirm}>Sì, rimuovi</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
