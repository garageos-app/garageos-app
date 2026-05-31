import { useState } from 'react';
import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import type { VehicleStatus } from '@/queries/types';
import { useVehicleTagDownload } from '@/queries/vehicleTag';
import { VehicleTagReprintDialog } from './VehicleTagReprintDialog';

export interface Props {
  vehicleId: string;
  tagFirstPrintedAt: string | null;
  status: VehicleStatus;
}

// Map known GET /v1/vehicles/:id/tag error codes to Italian copy.
function mapTagError(err: ApiError): string {
  switch (err.code) {
    case 'vehicle.archived':
      return 'Il tag non è disponibile per veicoli archiviati';
    case 'vehicle.not_certified':
      return 'Il tag è disponibile solo per veicoli certificati';
    case 'vehicle.not_found':
      return 'Veicolo non trovato';
    default:
      return 'Impossibile generare il tag. Riprova.';
  }
}

/**
 * Single-button component that triggers either a first-time presigned PDF tag
 * download (tagFirstPrintedAt === null) or opens the reprint dialog
 * (tagFirstPrintedAt !== null). Errors from the download mutation are displayed
 * inline below the button.
 *
 * F-OFF-104 / F-OFF-109
 */
export function VehicleTagPrintButton({ vehicleId, tagFirstPrintedAt, status }: Props) {
  const mutation = useVehicleTagDownload();
  const [reprintOpen, setReprintOpen] = useState(false);

  // See F-OFF-109: gate label and action on whether the tag has been printed before.
  const isReprint = tagFirstPrintedAt !== null;
  const label = isReprint ? 'Ristampa tag' : 'Stampa tag';

  // #6 tag-button status gate: the tag is only available for certified
  // vehicles (mirrors the backend BR-026 guard in vehicles-tag.ts). Disable
  // the button pre-emptively so the request never fires for non-certified
  // vehicles. Positive guard catches any future non-certified status.
  const disabledByStatus = status !== 'certified';
  const statusReason = !disabledByStatus
    ? null
    : status === 'archived'
      ? 'Non disponibile per veicoli archiviati'
      : 'Disponibile dopo la certificazione';
  const statusReasonId = 'tag-status-reason';

  const errorMessage =
    mutation.isError && mutation.error instanceof ApiError
      ? mapTagError(mutation.error)
      : mutation.isError
        ? 'Impossibile generare il tag. Riprova.'
        : null;

  const handleClick = () => {
    if (isReprint) {
      setReprintOpen(true);
    } else {
      mutation.mutate(vehicleId);
    }
  };

  // Absolute-position the error message so it does not contribute to layout
  // height. Without this, the parent action row (items-center) shifts the
  // button up when the alert appears.
  return (
    <div className="relative flex flex-col items-start">
      <Button
        type="button"
        variant="outline"
        disabled={disabledByStatus || mutation.isPending}
        aria-describedby={statusReason ? statusReasonId : undefined}
        onClick={handleClick}
      >
        <Printer className="mr-2 h-4 w-4" />
        {mutation.isPending ? 'Generazione PDF...' : label}
      </Button>
      {statusReason && (
        <p
          id={statusReasonId}
          className="absolute left-0 top-full mt-1 max-w-xs text-sm text-muted-foreground"
        >
          {statusReason}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="absolute left-0 top-full mt-1 max-w-xs text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      <VehicleTagReprintDialog
        vehicleId={vehicleId}
        open={reprintOpen}
        onOpenChange={setReprintOpen}
      />
    </div>
  );
}
