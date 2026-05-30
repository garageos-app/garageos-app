import { FileDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
 * Button that triggers the single-intervention PDF export. On success the
 * presigned URL opens in a new tab (handled by the hook). Errors are shown
 * inline below the button. Visible for every intervention status (a cancelled
 * intervention exports with an ANNULLATO banner — see F-OFF-309 PR1).
 */
export function InterventionExportPdfButton({ interventionId }: Props) {
  const mutation = useInterventionPdfDownload();

  const errorMessage =
    mutation.isError && mutation.error instanceof ApiError
      ? mapPdfError(mutation.error)
      : mutation.isError
        ? 'Impossibile generare il PDF. Riprova.'
        : null;

  // Absolute-position the error so it does not change the action row height.
  return (
    <div className="relative flex flex-col items-start">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(interventionId)}
      >
        <FileDown className="mr-2 h-4 w-4" />
        {mutation.isPending ? 'Generazione PDF...' : 'Esporta PDF'}
      </Button>
      {errorMessage && (
        <p role="alert" className="absolute left-0 top-full mt-1 max-w-xs text-sm text-destructive">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
