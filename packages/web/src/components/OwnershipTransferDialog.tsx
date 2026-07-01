// F-OFF-110 — Officina-mediated vehicle transfer dialog (BR-049).
// IT-strings hardcoded. 3-step wizard: cessionario, motivo+note, conferma.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { useCustomerSearch } from '@/queries/customerSearch';
import { useOwnershipTransfer, type OwnershipTransferRecipient } from '@/queries/ownershipTransfer';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Reason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

const REASON_OPTIONS: { value: Reason; label: string }[] = [
  { value: 'purchase', label: 'Vendita' },
  { value: 'inheritance', label: 'Eredità' },
  { value: 'company_assignment', label: 'Assegnazione aziendale' },
  { value: 'other', label: 'Altro' },
];

const NewRecipientSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Nome obbligatorio').max(100),
    lastName: z.string().trim().min(1, 'Cognome obbligatorio').max(100),
    email: z.string().trim().email('Email non valida').max(255),
    phone: z.string().trim().max(30).optional(),
    codiceFiscale: z.string().trim().max(20).optional(),
    isBusiness: z.boolean().optional(),
    businessName: z.string().trim().max(200).optional(),
    vatNumber: z.string().trim().max(20).optional(),
  })
  .refine((d) => !d.isBusiness || (Boolean(d.businessName) && Boolean(d.vatNumber)), {
    message: 'Ragione sociale e P.IVA obbligatorie per cliente aziendale',
    path: ['businessName'],
  });

type NewRecipientForm = z.infer<typeof NewRecipientSchema>;

interface SelectedRecipient {
  kind: 'existing' | 'new';
  data: OwnershipTransferRecipient;
  displayName: string;
  email: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: string;
  vehicleLabel: string;
  currentOwnerCustomerId: string;
}

export function OwnershipTransferDialog(props: Props) {
  const { open, onOpenChange, vehicleId, vehicleLabel, currentOwnerCustomerId } = props;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [search, setSearch] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [recipient, setRecipient] = useState<SelectedRecipient | null>(null);
  const [reason, setReason] = useState<Reason | ''>('');
  const [notes, setNotes] = useState('');

  const searchQuery = useCustomerSearch(search);
  const mutation = useOwnershipTransfer(vehicleId);

  const newForm = useForm<NewRecipientForm>({
    resolver: zodResolver(NewRecipientSchema),
    defaultValues: { firstName: '', lastName: '', email: '', isBusiness: false },
  });
  const isBusinessFlag = newForm.watch('isBusiness');

  function reset() {
    setStep(1);
    setSearch('');
    setShowNewForm(false);
    setRecipient(null);
    setReason('');
    setNotes('');
    newForm.reset();
  }

  function handleClose() {
    if (mutation.isPending) return;
    onOpenChange(false);
    reset();
  }

  function handleSelectExisting(customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  }) {
    if (customer.id === currentOwnerCustomerId) {
      toast.error('Il cessionario non può essere il proprietario attuale');
      return;
    }
    setRecipient({
      kind: 'existing',
      data: { kind: 'existing', customerId: customer.id },
      displayName: `${customer.firstName} ${customer.lastName}`.trim(),
      email: customer.email,
    });
    setStep(2);
  }

  function handleSubmitNew(data: NewRecipientForm) {
    setRecipient({
      kind: 'new',
      data: {
        kind: 'new',
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone || null,
        codiceFiscale: data.codiceFiscale || null,
        isBusiness: data.isBusiness ?? false,
        businessName: data.businessName || null,
        vatNumber: data.vatNumber || null,
      },
      displayName: `${data.firstName} ${data.lastName}`,
      email: data.email,
    });
    setStep(2);
  }

  async function handleConfirm() {
    if (!recipient || !reason) return;
    try {
      await mutation.mutateAsync({
        recipient: recipient.data,
        reason,
        notes: notes.trim() || null,
      });
      toast.success('Trasferimento completato');
      onOpenChange(false);
      reset();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const message =
        mapErrorCode(code) ?? (err instanceof Error ? err.message : 'Errore sconosciuto');
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : handleClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Trasferisci proprietà — Step {step}/3</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            {!showNewForm && (
              <>
                <div>
                  <Label htmlFor="recipient-search">Cerca cessionario</Label>
                  <Input
                    id="recipient-search"
                    placeholder="Nome, cognome o ragione sociale (min 2 caratteri)"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {searchQuery.data && search.trim().length >= 2 && (
                  <ul className="max-h-60 overflow-y-auto border rounded">
                    {searchQuery.data.data.map((c) => (
                      <li
                        key={c.id}
                        className="p-2 hover:bg-muted cursor-pointer border-b last:border-b-0"
                        onClick={() => handleSelectExisting(c)}
                        role="button"
                        data-testid={`recipient-result-${c.id}`}
                      >
                        <div className="font-medium">
                          {c.firstName} {c.lastName}
                        </div>
                        <div className="text-sm text-muted-foreground">{c.email}</div>
                      </li>
                    ))}
                    {searchQuery.data.data.length === 0 && (
                      <li className="p-2 text-sm text-muted-foreground">Nessun risultato</li>
                    )}
                  </ul>
                )}
                <Button variant="outline" onClick={() => setShowNewForm(true)} type="button">
                  Aggiungi nuovo cessionario
                </Button>
              </>
            )}
            {showNewForm && (
              <form onSubmit={newForm.handleSubmit(handleSubmitNew)} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="firstName">Nome *</Label>
                    <Input id="firstName" {...newForm.register('firstName')} />
                    {newForm.formState.errors.firstName && (
                      <p className="text-sm text-destructive">
                        {newForm.formState.errors.firstName.message}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="lastName">Cognome *</Label>
                    <Input id="lastName" {...newForm.register('lastName')} />
                    {newForm.formState.errors.lastName && (
                      <p className="text-sm text-destructive">
                        {newForm.formState.errors.lastName.message}
                      </p>
                    )}
                  </div>
                </div>
                <div>
                  <Label htmlFor="email">Email *</Label>
                  <Input id="email" type="email" {...newForm.register('email')} />
                  {newForm.formState.errors.email && (
                    <p className="text-sm text-destructive">
                      {newForm.formState.errors.email.message}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="phone">Telefono</Label>
                    <Input id="phone" {...newForm.register('phone')} />
                  </div>
                  <div>
                    <Label htmlFor="cf">Codice fiscale</Label>
                    <Input id="cf" {...newForm.register('codiceFiscale')} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="isBusiness"
                    checked={isBusinessFlag ?? false}
                    onCheckedChange={(v) => newForm.setValue('isBusiness', v)}
                  />
                  <Label htmlFor="isBusiness">Cliente aziendale</Label>
                </div>
                {isBusinessFlag && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="businessName">Ragione sociale *</Label>
                      <Input id="businessName" {...newForm.register('businessName')} />
                      {newForm.formState.errors.businessName && (
                        <p className="text-sm text-destructive">
                          {newForm.formState.errors.businessName.message}
                        </p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="vatNumber">P.IVA *</Label>
                      <Input id="vatNumber" {...newForm.register('vatNumber')} />
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <Button type="button" variant="outline" onClick={() => setShowNewForm(false)}>
                    Indietro
                  </Button>
                  <Button type="submit">Avanti</Button>
                </div>
              </form>
            )}
          </div>
        )}

        {step === 2 && recipient && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Cessionario: <strong>{recipient.displayName}</strong> ({recipient.email})
            </div>
            <div>
              <Label htmlFor="reason">Motivo trasferimento *</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as Reason)}>
                <SelectTrigger id="reason">
                  <SelectValue placeholder="Seleziona motivo" />
                </SelectTrigger>
                <SelectContent>
                  {REASON_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="notes">Note (opzionale)</Label>
              <Textarea
                id="notes"
                maxLength={1000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="text-xs text-muted-foreground">{notes.length} / 1000</div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(1)}>
                Indietro
              </Button>
              <Button onClick={() => setStep(3)} disabled={!reason}>
                Avanti
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && recipient && reason && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>
                Confermando il trasferimento, il veicolo <strong>{vehicleLabel}</strong> passerà a{' '}
                <strong>{recipient.displayName}</strong> in modo permanente. Questa azione non può
                essere annullata.
              </AlertDescription>
            </Alert>
            <div className="text-sm space-y-1">
              <div>
                <strong>Cessionario:</strong> {recipient.displayName} ({recipient.email})
              </div>
              <div>
                <strong>Motivo:</strong> {REASON_OPTIONS.find((o) => o.value === reason)?.label}
              </div>
              {notes && (
                <div>
                  <strong>Note:</strong> {notes}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(2)} disabled={mutation.isPending}>
                Indietro
              </Button>
              <Button variant="destructive" onClick={handleConfirm} disabled={mutation.isPending}>
                {mutation.isPending ? 'Trasferimento in corso…' : 'Conferma trasferimento'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function mapErrorCode(code: string | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    'vehicle.transfer.pending_not_transferable': 'Il veicolo non è certificato.',
    'vehicle.transfer.archived': 'Il veicolo è archiviato.',
    'vehicle.transfer.no_active_ownership': 'Il veicolo non ha un proprietario attivo.',
    'vehicle.transfer.active_transfer_exists':
      'È già in corso un trasferimento per questo veicolo.',
    'vehicle.transfer.same_owner': 'Il cessionario non può essere il proprietario attuale.',
    'vehicle.transfer.recipient_not_found': 'Cessionario non trovato.',
    'vehicle.transfer.role_denied': 'Ruolo non autorizzato per il trasferimento.',
    'vehicle.not_found': 'Veicolo non trovato.',
  };
  return map[code] ?? null;
}
