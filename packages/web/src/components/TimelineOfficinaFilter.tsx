import { ListFilter } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { officinaColor, type OfficinaColorMap } from '@/lib/officinaColors';
import type { TimelineOfficina } from '@/queries/types';

interface Props {
  officine: TimelineOfficina[];
  colorMap: OfficinaColorMap;
  // tenant_ids currently shown. Empty set is normalized by the parent to
  // "all" — see VehicleDetail.
  selected: Set<string>;
  onToggle: (tenantId: string) => void;
}

// Multiselect filter for the vehicle timeline: pick which officine's
// interventions to show. Each entry carries its stable color dot (shared with
// the timeline rows). Hidden by the parent when there is only one officina.
export function TimelineOfficinaFilter({ officine, colorMap, selected, onToggle }: Props) {
  const allSelected = selected.size === 0 || selected.size === officine.length;
  const label = allSelected ? 'Tutte le officine' : `${selected.size} officine`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2">
          <ListFilter size={14} />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Officine</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {officine.map((o) => {
          const color = officinaColor(colorMap, o.tenant_id);
          // Empty selection == all selected (parent normalizes), so reflect
          // "all checked" when the set is empty.
          const checked = selected.size === 0 || selected.has(o.tenant_id);
          return (
            <DropdownMenuCheckboxItem
              key={o.tenant_id}
              checked={checked}
              // Radix closes on select by default; keep the menu open so the
              // user can toggle several officine in one go.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => onToggle(o.tenant_id)}
            >
              <span className="flex items-center gap-2">
                <span className={cn('inline-block h-2.5 w-2.5 rounded-full', color.dot)} />
                <span className="truncate">{o.business_name}</span>
                {o.viewer_is_owner && <span className="text-xs text-muted-foreground">(tu)</span>}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
