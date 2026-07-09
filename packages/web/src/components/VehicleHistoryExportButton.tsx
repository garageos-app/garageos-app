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
import { useVehicleHistoryPdfDownload } from '@/queries/vehicleHistoryPdf';

export interface Props {
  vehicleId: string;
}

// Map known GET /v1/vehicles/:id/export.pdf error codes to Italian copy.
function mapPdfError(err: ApiError): string {
  switch (err.code) {
    case 'vehicle.not_found':
      return 'Veicolo non trovato';
    default:
      return 'Impossibile generare il PDF. Riprova.';
  }
}

/**
 * Officina history export: a button that opens a small options dialog (scope +
 * show-officina-names) and streams the vehicle-history PDF into a new tab. The
 * two switches default to the richest document: all officine, names shown.
 */
export function VehicleHistoryExportButton({ vehicleId }: Props) {
  const [open, setOpen] = useState(false);
  const [includeAllOfficine, setIncludeAllOfficine] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const mutation = useVehicleHistoryPdfDownload(vehicleId);

  const errorMessage =
    mutation.isError && mutation.error instanceof ApiError
      ? mapPdfError(mutation.error)
      : mutation.isError
        ? 'Impossibile generare il PDF. Riprova.'
        : null;

  const handleGenerate = () => {
    mutation.mutate(
      { scope: includeAllOfficine ? 'all' : 'own', showNames },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileDown className="mr-2 h-4 w-4" />
          Esporta storico PDF
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Esporta storico PDF</DialogTitle>
          <DialogDescription>
            Genera un PDF con lo storico degli interventi di questo veicolo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pdf-include-all" className="cursor-pointer">
              Includi anche le altre officine
            </Label>
            <Switch
              id="pdf-include-all"
              checked={includeAllOfficine}
              onCheckedChange={setIncludeAllOfficine}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pdf-show-names" className="cursor-pointer">
              Mostra nomi officine
            </Label>
            <Switch id="pdf-show-names" checked={showNames} onCheckedChange={setShowNames} />
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
