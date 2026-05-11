import { useEffect } from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiError } from '@/lib/api-client';
import { DisputeResponseCard } from './DisputeResponseCard';
import { DisputeRespondedCard } from './DisputeRespondedCard';
import { useInterventionDisputes, useRespondToDispute } from '@/queries/interventionDisputes';
import type { InterventionDispute } from '@/queries/types';

interface Props {
  interventionId: string;
  vehicleId: string;
  interventionTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Map known POST /dispute-response error codes to Italian copy.
// Returns { message, autoRefetch, closeDialog } where:
//   autoRefetch=true  → silent refetch so the dialog re-renders with updated state
//   closeDialog=true  → close the dialog after showing the toast (e.g. auth errors)
function mapResponseError(err: ApiError): {
  message: string;
  autoRefetch: boolean;
  closeDialog?: boolean;
} {
  switch (err.code) {
    case 'FORBIDDEN':
      // requireOfficinaPool guard (error-handler.ts CamelCase regex → 'FORBIDDEN').
      // Customer-pool tokens must not reach this endpoint; close dialog immediately.
      return {
        message: 'Accesso non autorizzato.',
        autoRefetch: false,
        closeDialog: true,
      };
    case 'intervention.dispute.response.permission_denied':
      return {
        message: "Solo i meccanici e l'amministratore possono rispondere alle contestazioni.",
        autoRefetch: false,
      };
    case 'intervention.dispute.response.no_active_dispute':
      return {
        message: 'La contestazione non è più aperta. Aggiorno la pagina.',
        autoRefetch: true,
      };
    case 'not_found':
      return {
        message: 'Contestazione non trovata. Aggiorno la pagina.',
        autoRefetch: true,
      };
    case 'intervention.dispute.response.description_too_short':
      return {
        message: 'La risposta deve essere di almeno 20 caratteri.',
        autoRefetch: false,
      };
    default:
      if (err.status >= 500) {
        return {
          message: 'Errore del server. Riprova tra qualche istante.',
          autoRefetch: false,
        };
      }
      return { message: err.message, autoRefetch: false };
  }
}

export function DisputeResponseDialog({
  interventionId,
  vehicleId,
  interventionTitle,
  open,
  onOpenChange,
}: Props) {
  const query = useInterventionDisputes(interventionId, { enabled: open });
  const mutation = useRespondToDispute(interventionId, vehicleId);

  // If the GET fails with intervention.not_found we close the dialog
  // — the timeline cache must be stale (intervention probably deleted
  // by another operator).
  useEffect(() => {
    if (
      open &&
      query.isError &&
      query.error instanceof ApiError &&
      query.error.code === 'intervention.not_found'
    ) {
      toast.error('Intervento non più disponibile.');
      onOpenChange(false);
    }
  }, [open, query.isError, query.error, onOpenChange]);

  const disputes = query.data ?? [];
  const openDisputes = disputes.filter((d) => d.status === 'open');
  const otherDisputes = disputes.filter((d) => d.status !== 'open');

  async function handleSubmit(dispute: InterventionDispute, tenantResponse: string) {
    try {
      const result = await mutation.mutateAsync({ disputeId: dispute.id, tenantResponse });
      // result.disputes is always InterventionDispute[] per DisputeResponseResult type (voce 12).
      const stillOpenAfter = result.disputes.some((d) => d.status === 'open');
      const message =
        !stillOpenAfter && result.interventionStatus === 'active'
          ? 'Risposta inviata. La contestazione è stata chiusa.'
          : 'Risposta inviata.';
      toast.success(message);
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped = mapResponseError(err);
        toast.error(mapped.message);
        if (mapped.closeDialog) {
          // Dialog is closing — child unmounts. Do NOT re-throw, else
          // DisputeResponseCard.finally runs setSubmitting(false) on an
          // unmounted form and React 18 warns. The user cannot retry an
          // auth-guard error from the same dialog anyway.
          onOpenChange(false);
          return;
        }
        if (mapped.autoRefetch) {
          await query.refetch();
        }
      } else {
        toast.error('Errore imprevisto. Riprova.');
      }
      throw err; // bubble so DisputeResponseCard keeps form state
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Contestazioni · {interventionTitle}</DialogTitle>
          <DialogDescription>
            Visualizza i motivi delle contestazioni del cliente e invia la tua risposta.
          </DialogDescription>
        </DialogHeader>

        {query.isPending && (
          <div className="space-y-3" data-testid="disputes-loading">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        )}

        {query.isError &&
          !(query.error instanceof ApiError && query.error.code === 'intervention.not_found') && (
            <Alert variant="destructive">
              <AlertDescription>
                {query.error instanceof Error
                  ? query.error.message
                  : 'Errore caricamento contestazioni.'}
              </AlertDescription>
            </Alert>
          )}

        {query.isSuccess && disputes.length === 0 && (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Nessuna contestazione su questo intervento.
          </p>
        )}

        {query.isSuccess && openDisputes.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
              Da rispondere
            </h3>
            {openDisputes.map((dispute) => (
              <DisputeResponseCard
                key={dispute.id}
                dispute={dispute}
                onSubmit={(response) => handleSubmit(dispute, response)}
              />
            ))}
          </section>
        )}

        {query.isSuccess && otherDisputes.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
              Già risposte
            </h3>
            {otherDisputes.map((dispute) => (
              <DisputeRespondedCard key={dispute.id} dispute={dispute} />
            ))}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
