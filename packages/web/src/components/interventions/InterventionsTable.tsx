// IT-strings — hardcoded, no i18n in this app
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { formatDate, formatKm } from '@/lib/format';
import type {
  InterventionListItem,
  InterventionSort,
  InterventionStatus,
  SortOrder,
} from '@/queries/interventionsList';

export const STATUS_LABEL: Record<InterventionStatus, string> = {
  active: 'Attivo',
  disputed: 'Contestato',
  cancelled: 'Cancellato',
};

export const STATUS_VARIANT: Record<InterventionStatus, 'secondary' | 'destructive' | 'outline'> = {
  active: 'secondary',
  disputed: 'destructive',
  cancelled: 'outline',
};

export interface InterventionsTableProps {
  items: InterventionListItem[];
  sort: InterventionSort;
  order: SortOrder;
  onSortChange: (sort: InterventionSort) => void;
}

interface Column {
  label: string;
  sortKey?: InterventionSort;
}

const COLUMNS: Column[] = [
  { label: 'Data', sortKey: 'date' },
  { label: 'Veicolo' },
  { label: 'Tipo', sortKey: 'type' },
  { label: 'Km', sortKey: 'km' },
  { label: 'Operatore', sortKey: 'operator' },
  { label: 'Stato', sortKey: 'status' },
];

function SortableHeader({
  column,
  sort,
  order,
  onSortChange,
}: {
  column: Column;
  sort: InterventionSort;
  order: SortOrder;
  onSortChange: (sort: InterventionSort) => void;
}) {
  const key = column.sortKey!;
  const active = sort === key;
  const orderLabel = order === 'asc' ? 'crescente' : 'decrescente';
  const ariaLabel = active
    ? `Ordina per ${column.label} (${orderLabel})`
    : `Ordina per ${column.label}`;

  return (
    <button
      type="button"
      onClick={() => onSortChange(key)}
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      {column.label}
      {active && (order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </button>
  );
}

export function InterventionsTable({ items, sort, order, onSortChange }: InterventionsTableProps) {
  const navigate = useNavigate();

  return (
    <div className="overflow-x-auto">
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              {COLUMNS.map((column) => (
                <th key={column.label} className="px-4 py-3 font-medium">
                  {column.sortKey ? (
                    <SortableHeader
                      column={column}
                      sort={sort}
                      order={order}
                      onSortChange={onSortChange}
                    />
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => (
              <tr
                key={item.id}
                onClick={() => navigate(`/interventions/${item.id}`)}
                className="cursor-pointer hover:bg-muted/50 transition"
              >
                <td className="px-4 py-3 whitespace-nowrap">{formatDate(item.interventionDate)}</td>
                <td className="px-4 py-3">
                  <Link
                    to={`/vehicles/${item.vehicle.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium hover:underline"
                  >
                    {item.vehicle.plate}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {item.vehicle.make} {item.vehicle.model}
                  </div>
                </td>
                <td className="px-4 py-3">{item.type.nameIt}</td>
                <td className="px-4 py-3 whitespace-nowrap">{formatKm(item.odometerKm)}</td>
                <td className="px-4 py-3">{item.operator.name}</td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
