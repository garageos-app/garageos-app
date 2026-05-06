import { useState } from 'react';
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

interface Props {
  interventionTypes: InterventionType[];
  registrationDate: string | null;
  onSubmit: (values: CreateInterventionFormValues) => void;
  submitting: boolean;
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

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)} noValidate className="space-y-6 max-w-2xl">
        {/* Required fields */}
        <div className="space-y-4">
          <div className="text-xs uppercase tracking-wider text-slate-500">Obbligatori</div>

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
              <p className="text-sm text-red-600 mt-1">
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
              <p className="text-sm text-red-600 mt-1">
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
              <p className="text-sm text-red-600 mt-1">
                {methods.formState.errors.odometerKm.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="desc">Descrizione *</Label>
            <Textarea id="desc" rows={4} {...methods.register('description')} />
            {methods.formState.errors.description && (
              <p className="text-sm text-red-600 mt-1">
                {methods.formState.errors.description.message}
              </p>
            )}
          </div>
        </div>

        {/* Optional collapsible sections */}
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500">Opzionali</div>

          {!showTitle ? (
            <button
              type="button"
              className="text-sm text-slate-700 hover:text-slate-900 block"
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
              className="text-sm text-slate-700 hover:text-slate-900 block"
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
              className="text-sm text-slate-700 hover:text-slate-900 block"
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
              className="text-sm text-slate-700 hover:text-slate-900 block"
              onClick={() => setShowDeadline(true)}
            >
              ▸ Programma scadenza
            </button>
          ) : (
            <DeadlineSection />
          )}
        </div>

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Salvataggio…' : 'Salva intervento'}
        </Button>
      </form>
    </FormProvider>
  );
}
