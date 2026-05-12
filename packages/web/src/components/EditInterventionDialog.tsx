import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Info, AlertTriangle } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PartsRepeater } from '@/components/intervention-form/PartsRepeater';
import { ApiError } from '@/lib/api-client';
import {
  EditInterventionFormSchema,
  type EditInterventionFormValues,
  type EditInterventionPayload,
} from '@/lib/validators/editIntervention';
import { useUpdateIntervention } from '@/queries/updateIntervention';
import { useInterventionTypes } from '@/queries/interventionTypes';
import { useInterventionDetail } from '@/queries/interventionDetail';
import type { InterventionDetail, ShopTimelineItem } from '@/queries/types';

interface Props {
  intervention: ShopTimelineItem;
  vehicleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Walker copied from InterventionForm.tsx (lesson PR #64 — Zod errors
// hidden in collapsed optional sections are invisible to users). Surface
// every leaf `message` string in a top-of-form Alert.
function collectErrorMessages(errors: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.length > 0) {
      out.push(obj.message);
      return;
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(errors);
  return out;
}

// Cheap structural deep-equality for the parts array. Field-by-field so it
// survives key-order shifts between the form-side Zod parse and any source
// where the array originates from a JSON serializer (e.g. Prisma).
//
// Exported for unit testing only. Fields mirror BasePartReplacedSchema in
// lib/validators/parts-replaced.ts. `code` and `notes` are optional/nullable
// at the type boundary; `??` normalizes undefined and null to null so the
// comparison is symmetric across both representations.
export function partsEqual(
  a: ReadonlyArray<{ name: string; code?: string | null; quantity: number; notes?: string | null }>,
  b: ReadonlyArray<{ name: string; code?: string | null; quantity: number; notes?: string | null }>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((part, i) => {
    const o = b[i];
    return (
      part.name === o.name &&
      (part.code ?? null) === (o.code ?? null) &&
      part.quantity === o.quantity &&
      (part.notes ?? null) === (o.notes ?? null)
    );
  });
}

function buildPatchBody(
  values: EditInterventionFormValues,
  original: EditInterventionFormValues,
): EditInterventionPayload {
  const patch: EditInterventionPayload = {};
  if (values.interventionTypeId !== original.interventionTypeId) {
    patch.interventionTypeId = values.interventionTypeId;
  }
  if (values.title !== original.title) {
    // Empty string -> null (clear); non-empty -> set.
    patch.title = values.title && values.title.length > 0 ? values.title : null;
  }
  if (values.description !== original.description) {
    patch.description = values.description;
  }
  if (values.internalNotes !== original.internalNotes) {
    patch.internalNotes =
      values.internalNotes && values.internalNotes.length > 0 ? values.internalNotes : null;
  }
  if (!partsEqual(values.partsReplaced ?? [], original.partsReplaced ?? [])) {
    patch.partsReplaced = values.partsReplaced ?? [];
  }
  // reason is wired only when locked AND >= 10 chars (handled inline).
  if (values.reason && values.reason.trim().length >= 10) {
    patch.reason = values.reason.trim();
  }
  return patch;
}

function mapApiError(err: ApiError): { message: string; close: boolean } {
  switch (err.code) {
    case 'intervention.modification.disputed':
      return {
        message: 'Intervento contestato: rispondi alla disputa prima di modificare.',
        close: true,
      };
    case 'intervention.modification.cancelled':
      return { message: 'Intervento cancellato: non modificabile.', close: true };
    case 'intervention.modification.revision_reason_required':
      return { message: 'Motivo richiesto (almeno 10 caratteri).', close: false };
    case 'NOT_FOUND':
    case 'not_found':
    case 'intervention.not_found':
      return { message: 'Intervento non trovato.', close: true };
    default:
      if (err.status === 403) {
        return { message: 'Non puoi modificare questo intervento.', close: true };
      }
      if (err.status >= 500) {
        return { message: 'Errore temporaneo, riprova.', close: false };
      }
      return { message: err.message || 'Errore imprevisto.', close: false };
  }
}

interface BodyProps {
  intervention: ShopTimelineItem;
  detail: InterventionDetail;
  vehicleId: string;
  onOpenChange: (open: boolean) => void;
}

function EditInterventionDialogBody({ intervention, detail, vehicleId, onOpenChange }: BodyProps) {
  const types = useInterventionTypes();
  const mutation = useUpdateIntervention(vehicleId);
  // BR-062 surfaced server-computed (see EditInterventionDialog.tsx pre-#85
  // for the rationale). Detail and timeline DTO agree on this boolean.
  const isLocked = !intervention.wiki_window_open;

  // Detail is the authoritative source for all editable fields. The
  // `intervention` prop is still passed for legacy reads (id, wiki_window_open,
  // type fallback for the Select) but defaults derive entirely from detail.
  // `code` and `notes` are null on the wire (snake_case nullable) but undefined
  // in the form Zod schema; ?? undefined adapts at the boundary.
  const defaults: EditInterventionFormValues = {
    interventionTypeId: detail.type.id,
    title: detail.title,
    description: detail.description,
    internalNotes: detail.internal_notes,
    partsReplaced: detail.parts_replaced.map((p) => ({
      name: p.name,
      code: p.code ?? undefined,
      quantity: p.quantity,
      notes: p.notes ?? undefined,
    })),
    reason: '',
  };

  const methods = useForm<EditInterventionFormValues>({
    resolver: zodResolver(EditInterventionFormSchema),
    defaultValues: defaults,
  });

  const [showTitle, setShowTitle] = useState(!!detail.title);
  const [showParts, setShowParts] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const allErrorMessages = collectErrorMessages(
    Object.fromEntries(Object.entries(methods.formState.errors).filter(([k]) => k !== 'reason')),
  );

  async function onSubmit(values: EditInterventionFormValues) {
    setFormError(null);
    if (isLocked && (!values.reason || values.reason.trim().length < 10)) {
      methods.setError('reason', {
        type: 'manual',
        message: 'Motivo richiesto (almeno 10 caratteri).',
      });
      return;
    }
    const patch = buildPatchBody(values, defaults);
    if (Object.keys(patch).length === 0) {
      setFormError('Nessuna modifica da salvare.');
      return;
    }
    try {
      await mutation.mutateAsync({ id: intervention.id, body: patch });
      toast.success('Intervento aggiornato');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped = mapApiError(err);
        if (mapped.close) {
          toast.error(mapped.message);
          onOpenChange(false);
        } else if (err.code === 'intervention.modification.revision_reason_required') {
          methods.setError('reason', { type: 'manual', message: mapped.message });
        } else {
          toast.error(mapped.message);
        }
      } else {
        toast.error('Errore imprevisto.');
      }
    }
  }

  const submitting = mutation.isPending;

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)} noValidate className="space-y-4">
        {isLocked ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Audit attivo. La modifica sarà registrata e visibile al cliente. Motivo richiesto.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Modifiche libere. La modifica non sarà tracciata né visibile al cliente.
            </AlertDescription>
          </Alert>
        )}

        {allErrorMessages.length > 0 && (
          <div
            className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
            role="alert"
          >
            <div className="font-medium mb-1">Correggi i campi seguenti:</div>
            <ul className="list-disc list-inside space-y-0.5">
              {allErrorMessages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {formError && (
          <div
            className="border border-amber-200 bg-amber-50 text-amber-900 rounded-md p-3 text-sm"
            role="alert"
          >
            {formError}
          </div>
        )}

        <div>
          <Label htmlFor="desc">Descrizione</Label>
          <Textarea id="desc" rows={4} {...methods.register('description')} />
          {methods.formState.errors.description && (
            <p className="text-sm text-red-600 mt-1">
              {methods.formState.errors.description.message}
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="type">Tipo intervento</Label>
          <Select
            value={methods.watch('interventionTypeId') ?? ''}
            onValueChange={(v) =>
              methods.setValue('interventionTypeId', v, { shouldValidate: true })
            }
          >
            <SelectTrigger id="type">
              <SelectValue placeholder="Seleziona…" />
            </SelectTrigger>
            <SelectContent>
              {types.data?.data.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.nameIt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!showTitle ? (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground block"
            onClick={() => setShowTitle(true)}
          >
            ▸ Aggiungi titolo personalizzato
          </button>
        ) : (
          <div>
            <Label htmlFor="title">Titolo</Label>
            <Input id="title" {...methods.register('title')} />
          </div>
        )}

        {!showParts ? (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground block"
            onClick={() => setShowParts(true)}
          >
            ▸ Modifica pezzi sostituiti
          </button>
        ) : (
          <div>
            <Label>Pezzi sostituiti</Label>
            <PartsRepeater />
          </div>
        )}

        {!showNotes ? (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground block"
            onClick={() => setShowNotes(true)}
          >
            ▸ Modifica note interne
          </button>
        ) : (
          <div>
            <Label htmlFor="notes">Note interne</Label>
            <Textarea id="notes" rows={3} {...methods.register('internalNotes')} />
          </div>
        )}

        {isLocked && (
          <div>
            <Label htmlFor="reason">Motivo della modifica (richiesto, min 10 caratteri)</Label>
            <Textarea id="reason" rows={3} {...methods.register('reason')} />
            <p className="text-xs text-muted-foreground mt-1">
              Sarà visibile al cliente nello storico revisioni.
            </p>
            {methods.formState.errors.reason && (
              <p className="text-sm text-red-600 mt-1">{methods.formState.errors.reason.message}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Annulla
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Salvataggio…' : 'Salva'}
          </Button>
        </DialogFooter>
      </form>
    </FormProvider>
  );
}

export function EditInterventionDialog({ intervention, vehicleId, open, onOpenChange }: Props) {
  // Detail prefetch: fetched on dialog open, drives defaults in the body
  // so that expanding a collapsed section + submitting unchanged does not
  // overwrite real DB values with empty defaults (data-loss risk closed
  // in slice J). The hook's `enabled` flag is the `id` argument being
  // string-truthy; we pass undefined while the dialog is closed.
  const detail = useInterventionDetail(open ? intervention.id : undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifica intervento</DialogTitle>
          <DialogDescription>Aggiorna i campi modificabili dell&apos;intervento.</DialogDescription>
        </DialogHeader>

        {detail.isError ? (
          <div className="space-y-4">
            <div
              className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
              role="alert"
            >
              Impossibile caricare l&apos;intervento. Riprova.
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Annulla
              </Button>
              <Button type="button" onClick={() => detail.refetch()}>
                Riprova
              </Button>
            </DialogFooter>
          </div>
        ) : detail.isPending || !detail.data ? (
          <div className="space-y-4">
            <div role="status" aria-label="Caricamento intervento" className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled>
                Annulla
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <EditInterventionDialogBody
            intervention={intervention}
            detail={detail.data}
            vehicleId={vehicleId}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
