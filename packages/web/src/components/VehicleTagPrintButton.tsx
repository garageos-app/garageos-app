import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useVehicleTagDownload } from '@/queries/vehicleTag';

interface Props {
  vehicleId: string;
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
 * Single-button component that triggers a presigned PDF tag download for the
 * given vehicle. On success the hook opens the URL in a new tab. Errors are
 * displayed inline below the button.
 *
 * F-OFF-104
 */
export function VehicleTagPrintButton({ vehicleId }: Props) {
  const mutation = useVehicleTagDownload();

  const errorMessage =
    mutation.isError && mutation.error instanceof ApiError
      ? mapTagError(mutation.error)
      : mutation.isError
        ? 'Impossibile generare il tag. Riprova.'
        : null;

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(vehicleId)}
      >
        <Printer className="mr-2 h-4 w-4" />
        {mutation.isPending ? 'Generazione PDF...' : 'Stampa tag'}
      </Button>
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
    </div>
  );
}
