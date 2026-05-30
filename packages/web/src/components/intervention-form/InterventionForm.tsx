import { useEffect, useState } from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

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
import {
  CreateInterventionFormSchema,
  type CreateInterventionFormValues,
} from '@/lib/validators/intervention';
import type { InterventionType } from '@/queries/types';
import { PartsRepeater } from './PartsRepeater';
import { DeadlineSection } from './DeadlineSection';
import { deriveDeadlineSuggestion } from '@/lib/deadline-suggestion';

interface Props {
  interventionTypes: InterventionType[];
  registrationDate: string | null;
  onSubmit: (values: CreateInterventionFormValues) => void;
  submitting: boolean;
}

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

export function InterventionForm({
  interventionTypes,
  registrationDate,
  onSubmit,
  submitting,
}: Props) {
  const todayIso = new Date().toISOString().slice(0, 10);

  const methods = useForm<CreateInterventionFormValues>({
    resolver: zodResolver(CreateInterventionFormSchema),
    // Default interventionDate to '' so empty-submit triggers "Data richiesta" validation
    defaultValues: {
      interventionTypeId: '',
      interventionDate: '',
      odometerKm: 0,
      description: '',
      partsReplaced: [],
    },
  });

  const interventionTypeId = useWatch({ control: methods.control, name: 'interventionTypeId' });

  const [showTitle, setShowTitle] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showDeadline, setShowDeadline] = useState(false);

  const selectedType = interventionTypes.find((t) => t.id === interventionTypeId) ?? null;
  const deadlineSuggestion = deriveDeadlineSuggestion(selectedType);

  // F-OFF-308: when the selected type suggests a follow-up deadline, open the
  // section and pre-fill it from the type's defaults with the switch ON
  // (opt-out — the operator confirms or disables). When the type does not
  // suggest one, force the switch OFF. Keyed on the selected type, so changing
  // the type always re-applies the new type's defaults (overwriting any prior
  // manual edits — intentional, no dirty-tracking).
  useEffect(() => {
    const suggestion = deriveDeadlineSuggestion(
      interventionTypes.find((t) => t.id === interventionTypeId) ?? null,
    );
    if (suggestion) {
      setShowDeadline(true);
      methods.setValue('createDeadline.enabled', true, { shouldValidate: false });
      methods.setValue('createDeadline.monthsFromNow', suggestion.months ?? undefined, {
        shouldValidate: false,
      });
      methods.setValue('createDeadline.kmIncrement', suggestion.km ?? undefined, {
        shouldValidate: false,
      });
    } else {
      methods.setValue('createDeadline.enabled', false, { shouldValidate: false });
    }
  }, [interventionTypeId, interventionTypes, methods]);

  // Surface every Zod validation error in a top-level Alert. Without this, an
  // invalid field nested inside a collapsed optional section (e.g. an empty
  // PartsRepeater row, or a NaN month in DeadlineSection) silently blocks the
  // submit and leaves the user with no feedback because the per-field error
  // <p> tag is not rendered when the section is collapsed.
  const allErrorMessages = collectErrorMessages(methods.formState.errors);

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)} noValidate className="space-y-6 max-w-2xl">
        {allErrorMessages.length > 0 && (
          <div
            className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
            role="alert"
          >
            <div className="font-medium mb-1">Correggi i campi seguenti prima di salvare:</div>
            <ul className="list-disc list-inside space-y-0.5">
              {allErrorMessages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {/* Required fields */}
        <div className="space-y-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Obbligatori</div>

          <div>
            <Label htmlFor="date">Data intervento *</Label>
            <Input
              id="date"
              type="date"
              max={todayIso}
              {...(registrationDate ? { min: registrationDate.slice(0, 10) } : {})}
              {...methods.register('interventionDate')}
            />
            {methods.formState.errors.interventionDate && (
              <p className="text-sm text-red-600 dark:text-red-300 mt-1">
                {methods.formState.errors.interventionDate.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="type">Tipo intervento *</Label>
            <Select
              onValueChange={(v) =>
                methods.setValue('interventionTypeId', v, { shouldValidate: true })
              }
              value={interventionTypeId ?? ''}
            >
              <SelectTrigger id="type">
                <SelectValue placeholder="Seleziona…" />
              </SelectTrigger>
              <SelectContent>
                {interventionTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.nameIt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {methods.formState.errors.interventionTypeId && (
              <p className="text-sm text-red-600 dark:text-red-300 mt-1">
                {methods.formState.errors.interventionTypeId.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="km">Km al momento *</Label>
            <Input
              id="km"
              type="number"
              min={0}
              {...methods.register('odometerKm', { valueAsNumber: true })}
            />
            {methods.formState.errors.odometerKm && (
              <p className="text-sm text-red-600 dark:text-red-300 mt-1">
                {methods.formState.errors.odometerKm.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="desc">Descrizione *</Label>
            <Textarea id="desc" rows={4} {...methods.register('description')} />
            {methods.formState.errors.description && (
              <p className="text-sm text-red-600 dark:text-red-300 mt-1">
                {methods.formState.errors.description.message}
              </p>
            )}
          </div>
        </div>

        {/* Optional collapsible sections */}
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Opzionali</div>

          {!showTitle ? (
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground block"
              onClick={() => setShowTitle(true)}
            >
              ▸ Aggiungi titolo
            </button>
          ) : (
            <div>
              <Label htmlFor="title">Titolo (opz)</Label>
              <Input id="title" {...methods.register('title')} />
            </div>
          )}

          {!showParts ? (
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground block"
              onClick={() => setShowParts(true)}
            >
              ▸ Pezzi sostituiti
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
              ▸ Note interne
            </button>
          ) : (
            <div>
              <Label htmlFor="notes">Note interne (opz)</Label>
              <Textarea id="notes" rows={3} {...methods.register('internalNotes')} />
            </div>
          )}

          {!showDeadline ? (
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground block"
              onClick={() => setShowDeadline(true)}
            >
              ▸ Programma scadenza
            </button>
          ) : (
            <DeadlineSection suggestion={deadlineSuggestion} />
          )}
        </div>

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Salvataggio…' : 'Salva intervento'}
        </Button>
      </form>
    </FormProvider>
  );
}
