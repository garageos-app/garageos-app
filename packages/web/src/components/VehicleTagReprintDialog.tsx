import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { useVehicleTagReprint } from '@/queries/vehicleTag';

const REASON_OPTIONS = [
  { value: 'lost', label: 'Smarrito' },
  { value: 'damaged', label: 'Danneggiato' },
  { value: 'other', label: 'Altro' },
] as const;

const formSchema = z
  .object({
    reason: z.enum(['lost', 'damaged', 'other'], {
      message: 'Seleziona un motivo',
    }),
    reasonNote: z.string().max(500).optional(),
    documentVerified: z.boolean(),
  })
  .refine((data) => data.documentVerified === true, {
    message: 'Devi confermare la verifica del documento',
    path: ['documentVerified'],
  })
  .refine(
    (data) =>
      data.reason !== 'other' || (data.reasonNote != null && data.reasonNote.trim().length >= 3),
    {
      message: 'Nota obbligatoria per il motivo "Altro" (min 3 caratteri)',
      path: ['reasonNote'],
    },
  );

type FormValues = z.infer<typeof formSchema>;

function mapReprintError(err: ApiError): string {
  switch (err.code) {
    case 'vehicle.archived':
      return 'Il tag non è disponibile per veicoli archiviati';
    case 'vehicle.not_certified':
      return 'Il tag è disponibile solo per veicoli certificati';
    case 'vehicle.not_found':
      return 'Veicolo non trovato';
    case 'vehicle_tag.never_printed':
      return 'Il tag deve essere stampato almeno una volta prima della ristampa';
    default:
      return 'Impossibile generare la ristampa. Riprova.';
  }
}

interface Props {
  vehicleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VehicleTagReprintDialog({ vehicleId, open, onOpenChange }: Props) {
  const reprint = useVehicleTagReprint(vehicleId);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { reason: undefined, reasonNote: '', documentVerified: false },
  });

  const reason = form.watch('reason');
  const documentVerified = form.watch('documentVerified');
  const submitDisabled = !documentVerified || !reason || reprint.isPending;

  const errorMessage = reprint.error instanceof ApiError ? mapReprintError(reprint.error) : null;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await reprint.mutateAsync({
        reason: values.reason,
        reasonNote: values.reason === 'other' ? values.reasonNote!.trim() : undefined,
        documentVerified: true as const,
      });
      onOpenChange(false);
      form.reset();
    } catch {
      // error mapped via reprint.error, dialog stays open
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ristampa tag</DialogTitle>
          <DialogDescription>
            Verifica il documento d'identità del proprietario prima di confermare.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="reason">Motivo</Label>
            <Select
              value={reason ?? ''}
              onValueChange={(val) =>
                form.setValue('reason', val as 'lost' | 'damaged' | 'other', {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger id="reason" aria-label="Motivo">
                <SelectValue placeholder="Seleziona motivo" />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.reason && (
              <p className="text-sm text-destructive">{form.formState.errors.reason.message}</p>
            )}
          </div>

          {reason === 'other' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="reasonNote">Specifica il motivo</Label>
              <Textarea
                id="reasonNote"
                aria-label="Specifica nota"
                {...form.register('reasonNote')}
                maxLength={500}
                rows={3}
              />
              {form.formState.errors.reasonNote && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.reasonNote.message}
                </p>
              )}
            </div>
          )}

          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="documentVerified"
              aria-label="Documento verificato"
              checked={documentVerified}
              onChange={(e) =>
                form.setValue('documentVerified', e.target.checked, { shouldValidate: true })
              }
              className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <Label htmlFor="documentVerified" className="text-sm font-normal leading-tight">
              Confermo di aver verificato il documento d'identità del proprietario.
            </Label>
          </div>
          {form.formState.errors.documentVerified && (
            <p className="text-sm text-destructive">
              {form.formState.errors.documentVerified.message}
            </p>
          )}

          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                form.reset();
                onOpenChange(false);
              }}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {reprint.isPending ? 'Generazione PDF...' : 'Conferma'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
