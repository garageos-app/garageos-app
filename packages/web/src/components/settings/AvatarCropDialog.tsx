import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cropAndResize, type CropArea } from '@/lib/avatarCanvas';

interface Props {
  open: boolean;
  imageSrc: string | null;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}

// AvatarCropDialog wraps react-easy-crop in a shadcn Dialog. The user
// drags + zooms; on confirm, the pixel coords are passed to cropAndResize
// which produces a 512×512 JPEG Blob ready to upload to S3.
//
// onConfirm runs synchronously once the Blob is generated. Upload
// orchestration lives in the parent (AvatarSection → useAvatarUpload).
export function AvatarCropDialog({ open, imageSrc, onCancel, onConfirm }: Props) {
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixelCrop, setPixelCrop] = useState<CropArea | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCropComplete = useCallback((_: unknown, area: CropArea) => {
    setPixelCrop(area);
  }, []);

  async function handleConfirm() {
    if (!imageSrc || !pixelCrop) return;
    setBusy(true);
    try {
      const blob = await cropAndResize(imageSrc, pixelCrop);
      onConfirm(blob);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ritaglia foto</DialogTitle>
        </DialogHeader>
        <div className="relative w-full h-80 bg-muted">
          {imageSrc && (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          )}
        </div>
        <div className="px-1 py-2">
          <label htmlFor="zoom" className="text-xs text-muted-foreground">
            Zoom
          </label>
          <input
            id="zoom"
            type="range"
            min={1}
            max={3}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Annulla
          </Button>
          <Button onClick={handleConfirm} disabled={busy || !pixelCrop}>
            {busy ? 'Elaborando...' : 'Conferma'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
