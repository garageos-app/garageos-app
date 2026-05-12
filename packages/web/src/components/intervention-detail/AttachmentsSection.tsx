import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes, formatDate } from '@/lib/format';
import { AttachmentDropzone } from './AttachmentDropzone';
import { useAttachmentViewUrl } from '@/queries/interventionDetail';
import { useAttachmentUpload } from '@/queries/attachmentUpload';
import {
  MAX_ATTACHMENTS_PER_INTERVENTION,
  MAX_FILE_SIZE_BYTES,
  validateFileForUpload,
  type ValidationError,
} from '@/lib/attachmentValidation';
import type { InterventionAttachment } from '@/queries/types';

interface Props {
  attachments: InterventionAttachment[];
  interventionId: string;
}

function formatValidationMessage(err: ValidationError): string {
  switch (err.code) {
    case 'mime_not_supported':
      return 'Formato non supportato. Usa JPG, PNG, WebP, HEIC o PDF.';
    case 'size_exceeded':
      return `File troppo grande. Massimo ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`;
    case 'count_exceeded':
      return 'Limite di allegati raggiunto.';
  }
}

/**
 * Attachments card for the intervention detail page (F-OFF-305).
 *
 * Composes:
 * 1. A header showing `Allegati (N/10)` (BR-180 cap visible upfront).
 * 2. A dropzone (`AttachmentDropzone`) for drag&drop + picker + preview +
 *    progress. Hides itself at the BR-180 cap (count = 10).
 * 3. The existing list of attachments with per-row Mostra (lazy view-url).
 *
 * Empty-state regression (post #86): the card is now ALWAYS visible to
 * surface the upload affordance (previously returned `null` when empty).
 * `interventionId` is a required prop because the upload hook needs to
 * invalidate `['intervention-detail', id]` on success.
 */
export function AttachmentsSection({ attachments, interventionId }: Props) {
  const viewUrl = useAttachmentViewUrl();
  const upload = useAttachmentUpload(interventionId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  // Image preview (blob URL) — for decodable image mimes only. HEIC/HEIF
  // are excluded because non-iOS browsers cannot render them, producing a
  // broken-image icon. The file uploads correctly regardless; only the
  // pre-upload preview falls through to the file-icon placeholder.
  const previewUrl = useMemo(() => {
    if (!selectedFile) return null;
    const mime = selectedFile.type;
    if (mime.startsWith('image/') && mime !== 'image/heic' && mime !== 'image/heif') {
      return URL.createObjectURL(selectedFile);
    }
    return null;
  }, [selectedFile]);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Surface success as a toast + reset the picker; the list itself refreshes
  // via the upload hook's invalidateQueries.
  const successFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (upload.state.phase === 'success' && successFiredRef.current !== upload.state.attachmentId) {
      successFiredRef.current = upload.state.attachmentId;
      toast.success('Allegato caricato');
      setSelectedFile(null);
      setValidationMessage(null);
      upload.reset();
    }
  }, [upload.state, upload]);

  const handleShow = async (id: string) => {
    setBusyId(id);
    try {
      const { url } = await viewUrl.mutateAsync(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error("Impossibile aprire l'allegato.");
    } finally {
      setBusyId(null);
    }
  };

  const handleSelect = (file: File | null) => {
    if (file === null) {
      toast.error('Carica un file alla volta, non una cartella.');
      return;
    }
    const err = validateFileForUpload(file, attachments.length);
    if (err) {
      setSelectedFile(null);
      setValidationMessage(formatValidationMessage(err));
      return;
    }
    setSelectedFile(file);
    setValidationMessage(null);
  };

  const handleUpload = () => {
    if (selectedFile) void upload.upload(selectedFile);
  };

  const handleCancel = () => {
    setSelectedFile(null);
    setValidationMessage(null);
    upload.reset();
  };

  const handleReset = () => {
    upload.reset();
    setValidationMessage(null);
    // Keep selectedFile so user can retry with the same file in one click.
  };

  const showDropzone = attachments.length < MAX_ATTACHMENTS_PER_INTERVENTION;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Allegati ({attachments.length}/{MAX_ATTACHMENTS_PER_INTERVENTION})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {showDropzone ? (
          <AttachmentDropzone
            state={upload.state}
            selectedFile={selectedFile}
            previewUrl={previewUrl}
            validationMessage={validationMessage}
            onSelect={handleSelect}
            onUpload={handleUpload}
            onCancel={handleCancel}
            onReset={handleReset}
          />
        ) : (
          <div className="text-xs text-muted-foreground italic">
            Limite di 10 allegati raggiunto. Elimina un allegato prima di caricarne un altro.
          </div>
        )}

        {attachments.length > 0 && (
          <ul className="divide-y divide-border">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2 gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground truncate">{a.file_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(a.size_bytes)} · {formatDate(a.created_at)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleShow(a.id)}
                  disabled={busyId === a.id}
                >
                  {busyId === a.id ? 'Apertura…' : 'Mostra'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
