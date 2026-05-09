import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from '@/components/ui/command';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useCustomerSearch } from '@/queries/customerSearch';
import type { Customer } from '@/queries/types';

// E2 customer autocomplete officina. Consumes /v1/customers/search
// (PR #77) and surfaces a tenant-scoped name search to the operator.
// Selection navigates the consumer to the customer's vehicle list
// (Dashboard wires onSelect → /search?customer=<id>&t=customer).

interface Props {
  onSelect: (customer: Customer) => void;
}

function customerLabel(c: Customer): string {
  return c.isBusiness && c.businessName ? c.businessName : `${c.firstName} ${c.lastName}`.trim();
}

export function CustomerAutocomplete({ onSelect }: Props) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const debounced = useDebouncedValue(trimmed, 250);
  const query = useCustomerSearch(debounced);

  const showHint = trimmed.length > 0 && trimmed.length < 2;
  const showResults = trimmed.length >= 2;

  return (
    <div className="w-full max-w-2xl">
      <Command shouldFilter={false} className="rounded-md border shadow-sm">
        <CommandInput
          placeholder="Digita nome o cognome cliente…"
          value={value}
          onValueChange={setValue}
          autoFocus
        />
        <CommandList>
          {showHint && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Digita almeno 2 caratteri.
            </div>
          )}
          {showResults && query.isPending && <CommandLoading>Cercando…</CommandLoading>}
          {showResults && query.isError && (
            <div className="py-6 text-center text-sm text-destructive">Errore. Riprova.</div>
          )}
          {showResults && query.isSuccess && query.data.data.length === 0 && (
            <CommandEmpty>Nessun cliente trovato.</CommandEmpty>
          )}
          {showResults && query.isSuccess && query.data.data.length > 0 && (
            <CommandGroup>
              {query.data.data.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  onSelect={() => onSelect(c)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{customerLabel(c)}</span>
                    {c.isBusiness && <Badge variant="secondary">B2B</Badge>}
                  </div>
                  <span className="text-xs text-muted-foreground">{c.email}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
