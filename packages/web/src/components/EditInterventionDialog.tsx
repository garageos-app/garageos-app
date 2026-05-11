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
import type { ShopTimelineItem } from '@/queries/types';

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

// Cheap deep-equality for the parts array. Stable because both sides
// originate from Zod parses with the same key order.
function partsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

export function EditInterventionDialog({ intervention, vehicleId, open, onOpenChange }: Props) {
  const types = useInterventionTypes();
  const mutation = useUpdateIntervention(vehicleId);
  const isLocked = intervention.wiki_locked_at !== null;

  const defaults: EditInterventionFormValues = {
    interventionTypeId: intervention.type.id,
    title: intervention.title ?? null,
    description: intervention.description,
    internalNotes: null, // timeline DTO does not expose internalNotes — see note below.
    partsReplaced: [], // timeline DTO does not expose partsReplaced JSON — see note below.
    reason: '',
  };

  // NOTE: timeline DTO surfaces parts_replaced_count and a coarse
  // description but NOT the raw `partsReplaced` JSON nor `internalNotes`.
  // Starting these defaults at empty is intentional: the diff helper
  // will only include them in the PATCH body if the user explicitly
  // edits them. If the user leaves them untouched, the backend keeps
  // the existing DB values (PATCH is per-field partial). The collapsible
  // sections render closed by default in this case so the user sees an
  // explicit "Pezzi sostituiti" / "Note interne" toggle rather than an
  // empty editor that looks like data was lost.

  const methods = useForm<EditInterventionFormValues>({
    resolver: zodResolver(EditInterventionFormSchema),
    defaultValues: defaults,
  });

  // Collapsible expansion state. partsReplaced and internalNotes default
  // to collapsed because the timeline DTO does not surface their full
  // contents; expanding the section is the user's signal that they
  // intend to overwrite. Title is auto-expanded if the row already has
  // one (so the user sees what's there rather than an "Aggiungi titolo"
  // button on an intervention that already has a title).
  const [showTitle, setShowTitle] = useState(!!intervention.title);
  const [showParts, setShowParts] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);

  // Exclude `reason` from the aggregated error list — it is always
  // rendered inline under the textarea, so surfacing it in the top
  // summary as well would duplicate it and confuse the user.
  const allErrorMessages = collectErrorMessages(
    Object.fromEntries(Object.entries(methods.formState.errors).filter(([k]) => k !== 'reason')),
  );

  async function onSubmit(values: EditInterventionFormValues) {
    setFormError(null);

    // Locked-but-reason-too-short guard: inline error under reason.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifica intervento</DialogTitle>
          <DialogDescription>Aggiorna i campi modificabili dell&apos;intervento.</DialogDescription>
        </DialogHeader>

        <FormProvider {...methods}>
          <form onSubmit={methods.handleSubmit(onSubmit)} noValidate className="space-y-4">
            {/* BR-062 banner. Caution (not error) state — the icon
                differentiates wiki vs locked. The alert.tsx primitive
                only exposes `default` and `destructive`; destructive
                styling would overstate the locked state as an error. */}
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

            {/* Top-of-form aggregated Zod errors (lesson PR #64) */}
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

            {/* Form-level error (no-change guard) */}
            {formError && (
              <div
                className="border border-amber-200 bg-amber-50 text-amber-900 rounded-md p-3 text-sm"
                role="alert"
              >
                {formError}
              </div>
            )}

            {/* Description */}
            <div>
              <Label htmlFor="desc">Descrizione</Label>
              <Textarea id="desc" rows={4} {...methods.register('description')} />
              {methods.formState.errors.description && (
                <p className="text-sm text-red-600 mt-1">
                  {methods.formState.errors.description.message}
                </p>
              )}
            </div>

            {/* Intervention type select */}
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

            {/* Title (collapsible) */}
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

            {/* Parts replaced (collapsible) */}
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

            {/* Internal notes (collapsible) */}
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

            {/* Reason (only when locked) */}
            {isLocked && (
              <div>
                <Label htmlFor="reason">Motivo della modifica (richiesto, min 10 caratteri)</Label>
                <Textarea id="reason" rows={3} {...methods.register('reason')} />
                <p className="text-xs text-muted-foreground mt-1">
                  Sarà visibile al cliente nello storico revisioni.
                </p>
                {methods.formState.errors.reason && (
                  <p className="text-sm text-red-600 mt-1">
                    {methods.formState.errors.reason.message}
                  </p>
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
      </DialogContent>
    </Dialog>
  );
}
