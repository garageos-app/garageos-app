import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface KmConfirmDialogProps {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function KmConfirmDialog({
  open,
  message,
  onConfirm,
  onCancel,
  loading,
}: KmConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Km inferiori allo storico</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Correggi
          </Button>
          <Button onClick={onConfirm} disabled={loading}>
            {loading ? 'Salvataggio…' : 'Conferma e salva'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
