import { Plus, Trash2 } from 'lucide-react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

export function PartsRepeater() {
  const { control, register } = useFormContext<CreateInterventionFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'partsReplaced' });

  return (
    <div className="space-y-2">
      {fields.length === 0 ? (
        <p className="text-sm text-slate-500">Nessun pezzo registrato.</p>
      ) : (
        fields.map((f, i) => (
          <div key={f.id} className="grid grid-cols-[1fr_120px_80px_36px] gap-2 items-start">
            <Input placeholder="Nome pezzo" {...register(`partsReplaced.${i}.name`)} />
            <Input placeholder="Codice (opz)" {...register(`partsReplaced.${i}.code`)} />
            <Input
              type="number"
              placeholder="Quantità"
              step="any"
              {...register(`partsReplaced.${i}.quantity`, { valueAsNumber: true })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Rimuovi pezzo ${i + 1}`}
              onClick={() => remove(i)}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ name: '', quantity: 1 })}
      >
        <Plus size={14} className="mr-1" /> Aggiungi pezzo
      </Button>
    </div>
  );
}
