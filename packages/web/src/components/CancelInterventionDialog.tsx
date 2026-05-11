import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiError } from '@/lib/api-client';
import { useCancelIntervention } from '@/queries/interventionDetail';

const schema = z.object({
  reason: z
    .string()
    .min(20, 'La motivazione deve essere di almeno 20 caratteri.')
    .max(1000, 'Massimo 1000 caratteri.'),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  interventionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MappedError =
  | { type: 'inline'; field: 'reason'; message: string }
  | { type: 'toast'; keepOpen: boolean; message: string };

// Maps backend error codes → UI behavior. Codes taken VERBATIM from
// packages/api/src/routes/v1/interventions-cancel.ts (3 domain codes)
// and the global error-handler (P2025 → 'NOT_FOUND' uppercase). Both
// case variants are handled defensively (lesson feedback_verify_api_contract_against_backend.md).
function mapCancelError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    switch (err.code) {
      // See BR-066: server also validates reason >= 20 chars as a
      // last-resort server-side guard. We validate client-side first so
      // this should never fire in practice — but map it inline just in
      // case a trimming edge-case slips through.
      case 'intervention.cancellation.reason_too_short':
        return {
          type: 'inline',
          field: 'reason',
          message: 'La motivazione deve essere di almeno 20 caratteri.',
        };
      // BR-066: only super_admin may cancel. Close dialog — the
      // operator cannot fix this by retrying.
      case 'intervention.cancellation.permission_denied':
        return {
          type: 'toast',
          keepOpen: false,
          message: "Solo l'admin dell'officina può annullare un intervento.",
        };
      // Stale UI — intervention already cancelled. Close dialog.
      case 'intervention.cancellation.already_cancelled':
        return {
          type: 'toast',
          keepOpen: false,
          message: 'Intervento già annullato.',
        };
      // P2025 → 'NOT_FOUND' (uppercase) from error-handler.ts.
      // 'not_found' lowercase variant kept for defensive coverage.
      case 'NOT_FOUND':
      case 'not_found':
        return {
          type: 'toast',
          keepOpen: false,
          message: 'Intervento non trovato.',
        };
      default:
        if (err.status >= 500) {
          return {
            type: 'toast',
            keepOpen: true,
            message: 'Errore del server. Riprova tra qualche istante.',
          };
        }
        return {
          type: 'toast',
          keepOpen: true,
          message: 'Errore imprevisto.',
        };
    }
  }
  return { type: 'toast', keepOpen: true, message: 'Errore imprevisto.' };
}

/**
 * Officina-only dialog to cancel an intervention (F-OFF-307 / BR-066).
 *
 * Reason must be ≥20 characters (enforced client-side and re-checked server-side).
 * Cancellation is irreversible and cascades open disputes to
 * `resolved_by_cancellation` (BR-130). IT-strings hardcoded (officina UX only).
 */
export function CancelInterventionDialog({ interventionId, open, onOpenChange }: Props) {
  const cancel = useCancelIntervention(interventionId);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { reason: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await cancel.mutateAsync({ reason: values.reason });
      toast.success('Intervento annullato.');
      form.reset();
      onOpenChange(false);
    } catch (err) {
      const mapped = mapCancelError(err);
      if (mapped.type === 'inline') {
        form.setError(mapped.field, { message: mapped.message });
        return;
      }
      toast.error(mapped.message);
      if (!mapped.keepOpen) {
        form.reset();
        onOpenChange(false);
      }
    }
  });

  const reasonValue = form.watch('reason') ?? '';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) form.reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Annulla intervento</DialogTitle>
          <DialogDescription>
            Questa azione è irreversibile. L&apos;intervento sarà marcato come
            &quot;Annullato&quot;.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertDescription>
            L&apos;annullamento è visibile al cliente nella sua timeline e risolve automaticamente
            eventuali contestazioni aperte (BR-130).
          </AlertDescription>
        </Alert>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="cancel-reason">Motivo dell&apos;annullamento *</Label>
            <Textarea
              id="cancel-reason"
              rows={5}
              maxLength={1000}
              {...form.register('reason')}
              aria-invalid={form.formState.errors.reason ? true : undefined}
            />
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>{form.formState.errors.reason?.message ?? 'Almeno 20 caratteri.'}</span>
              <span>{reasonValue.length} / 1000</span>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                form.reset();
                onOpenChange(false);
              }}
            >
              Chiudi
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending ? 'Annullamento…' : 'Annulla intervento'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
