import { useState } from 'react';
import { FileDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import { useInterventionPdfDownload } from '@/queries/interventionPdf';

export interface Props {
  interventionId: string;
}

// Map known GET /v1/interventions/:id/pdf error codes to Italian copy.
function mapPdfError(err: ApiError): string {
  switch (err.code) {
    case 'intervention.not_found':
      return 'Intervento non trovato';
    default:
      return 'Impossibile generare il PDF. Riprova.';
  }
}

/**
 * Button that opens a small options dialog (show-officina-name) and streams the
 * single-intervention PDF into a new tab. The document mirrors the bulk
 * vehicle-history export scoped to this one intervention; the switch only
 * controls whether the officina's own name is printed on it. Visible for every
 * intervention status.
 */
export function InterventionExportPdfButton({ interventionId }: Props) {
  const [open, setOpen] = useState(false);
  const [showNames, setShowNames] = useState(true);
  const mutation = useInterventionPdfDownload();

  const errorMessage =
    mutation.isError && mutation.error instanceof ApiError
      ? mapPdfError(mutation.error)
      : mutation.isError
        ? 'Impossibile generare il PDF. Riprova.'
        : null;

  const handleGenerate = () => {
    mutation.mutate({ interventionId, showNames }, { onSuccess: () => setOpen(false) });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) mutation.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileDown className="mr-2 h-4 w-4" />
          Esporta PDF
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Esporta PDF intervento</DialogTitle>
          <DialogDescription>Genera un PDF di questo intervento.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="intervention-pdf-show-names" className="cursor-pointer">
              Mostra nome officina
            </Label>
            <Switch
              id="intervention-pdf-show-names"
              checked={showNames}
              onCheckedChange={setShowNames}
            />
          </div>
        </div>

        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}

        <DialogFooter>
          <Button type="button" onClick={handleGenerate} disabled={mutation.isPending}>
            {mutation.isPending ? 'Generazione PDF...' : 'Genera PDF'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
