import { useRef, type DragEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { UploadState } from '@/queries/attachmentUpload';
import { ALLOWED_MIME_TYPES, MAX_ATTACHMENTS_PER_INTERVENTION } from '@/lib/attachmentValidation';

interface Props {
  currentCount: number;
  state: UploadState;
  selectedFile?: File | null;
  previewUrl?: string | null;
  validationMessage?: string | null;
  // onSelect receives the validated File (parent applies validateFileForUpload)
  // or `null` when the drop is rejected pre-validation (multi-file / directory).
  onSelect: (file: File | null) => void;
  onUpload: () => void;
  onCancel: () => void;
  onReset: () => void;
}

// Some Chromium builds do not honor `image/heic` in <input accept>; pairing
// with the `.heic` extension fallback covers them. See BR-180 / spec.
const ACCEPT_ATTR = [...ALLOWED_MIME_TYPES, '.heic'].join(',');

/**
 * Visual dropzone + picker + preview + progress for F-OFF-305 upload UI.
 * Pure presentational: validation and orchestration are owned by the parent
 * (AttachmentsSection). Hides itself entirely when the intervention is at
 * the BR-180 cap (10 attachments) and shows a static "limit reached" line.
 */
export function AttachmentDropzone({
  currentCount,
  state,
  selectedFile,
  previewUrl,
  validationMessage,
  onSelect,
  onUpload,
  onCancel,
  onReset,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (currentCount >= MAX_ATTACHMENTS_PER_INTERVENTION) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Limite di 10 allegati raggiunto. Elimina un allegato prima di caricarne un altro.
      </div>
    );
  }

  const isInFlight =
    state.phase === 'requesting' || state.phase === 'uploading' || state.phase === 'confirming';

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (isInFlight) return;
    const files = e.dataTransfer.files;
    const items = e.dataTransfer.items;
    if (files.length !== 1) {
      onSelect(null);
      return;
    }
    const first = items[0];
    const entry =
      'webkitGetAsEntry' in first
        ? (first as { webkitGetAsEntry: () => { isDirectory: boolean } }).webkitGetAsEntry()
        : null;
    if (entry?.isDirectory) {
      onSelect(null);
      return;
    }
    onSelect(files[0]);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) onSelect(f);
    e.target.value = '';
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Trascina qui un file o premi Invio per selezionare"
        aria-disabled={isInFlight}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onKeyDown={handleKeyDown}
        className="border-2 border-dashed border-border rounded-lg p-6 text-center focus-visible:ring-2 focus-visible:ring-primary"
      >
        <p className="text-sm text-muted-foreground">Trascina qui un file oppure</p>
        <label className="inline-block mt-2 text-sm font-medium text-primary cursor-pointer hover:underline">
          Seleziona file
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={handleFileInput}
            disabled={isInFlight}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">JPG, PNG, WebP, HEIC, PDF · max 10 MB</p>
      </div>

      {/* Preview slot */}
      {selectedFile && state.phase !== 'success' && (
        <div className="flex items-center gap-3 p-3 border border-border rounded-md">
          {/* Structural barrier: only render <img> when previewUrl is a browser-
              generated blob: URL from URL.createObjectURL (never user HTML).
              Satisfies CodeQL js/xss-through-dom by gating the sink on a
              schema check the rule recognizes as a sanitizer. */}
          {previewUrl && previewUrl.startsWith('blob:') ? (
            <img src={previewUrl} alt="" className="w-16 h-16 object-cover rounded" />
          ) : (
            <div className="w-16 h-16 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">
              {selectedFile.type === 'application/pdf' ? 'PDF' : 'FILE'}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{selectedFile.name}</div>
            <div className="text-xs text-muted-foreground">
              {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
            </div>
          </div>
        </div>
      )}

      {/* Validation inline error (aria-live for SR announce) */}
      {validationMessage && (
        <div aria-live="polite" className="text-sm text-destructive">
          {validationMessage}
        </div>
      )}

      {/* Progress bar during uploading */}
      {state.phase === 'uploading' && (
        <div
          role="progressbar"
          aria-valuenow={Math.round(state.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Caricamento in corso"
        >
          <Progress value={state.progress * 100} />
        </div>
      )}

      {/* Error block */}
      {state.phase === 'error' && (
        <div aria-live="polite" className="text-sm text-destructive">
          {state.message}
        </div>
      )}

      {/* Action buttons */}
      {selectedFile && state.phase === 'idle' && (
        <div className="flex gap-2">
          <Button size="sm" onClick={onUpload} aria-busy={false}>
            Carica
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel}>
            Annulla
          </Button>
        </div>
      )}
      {state.phase === 'error' && (
        <Button size="sm" onClick={onReset}>
          Riprova
        </Button>
      )}
      {isInFlight && (
        <Button size="sm" disabled aria-busy="true">
          Caricamento…
        </Button>
      )}
    </div>
  );
}
