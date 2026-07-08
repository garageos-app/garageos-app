// IT-strings — hardcoded, no i18n in this app
import { Check, ChevronsUpDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectPopoverProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  emptyText?: string;
  disabled?: boolean;
}

// Generic multi-select built on Popover + Command (this app has no shadcn
// multiselect/checkbox primitive). Mirrors the Command usage in
// CustomerAutocomplete.tsx. Toggling an item calls onChange with the next
// selection array; the parent owns the state (URL is the source of truth).
export function MultiSelectPopover({
  label,
  options,
  selected,
  onChange,
  searchable = false,
  emptyText = 'Nessun risultato.',
  disabled = false,
}: MultiSelectPopoverProps) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={disabled} className="justify-between gap-2 font-normal">
          <span>{label}</span>
          {selected.length > 0 && <Badge variant="secondary">{selected.length}</Badge>}
          <ChevronsUpDown size={14} className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command shouldFilter={searchable}>
          {searchable && <CommandInput placeholder="Cerca…" />}
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.includes(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    // cmdk filters on `value`; include the label so a
                    // searchable list matches typed text, and append the id
                    // to keep values unique across same-label options.
                    value={`${option.label} ${option.value}`}
                    onSelect={() => toggle(option.value)}
                    className="flex items-center gap-2"
                  >
                    <Check size={14} className={isSelected ? 'opacity-100' : 'opacity-0'} />
                    {option.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
