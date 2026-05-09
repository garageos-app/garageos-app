import { useNavigate } from 'react-router-dom';
import { Calendar, Gauge, User } from 'lucide-react';

import { formatDate, formatKm } from '@/lib/format';
import type { TenantDeadline } from '@/queries/types';

// Single row for the deadline dashboard. Click anywhere on the row
// navigates to the underlying vehicle detail page so the operator
// can register a closing intervention or inspect history.
//
// Customer name follows the existing PII pattern from
// VehicleResultCard: when redacted, firstName/lastName are
// effectively undefined and the truthy-check renders "—".

interface Props {
  item: TenantDeadline;
}

export function DeadlineRow({ item }: Props) {
  const navigate = useNavigate();
  const customer = item.vehicle.currentOwnership?.customer ?? null;
  const customerName =
    customer && customer.firstName && customer.lastName
      ? `${customer.firstName} ${customer.lastName}`
      : '—';

  return (
    <button
      type="button"
      onClick={() => navigate(`/vehicles/${item.vehicleId}`)}
      className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-blue-50/30 dark:hover:bg-blue-950/30 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-foreground truncate">
          {item.vehicle.make} {item.vehicle.model}{' '}
          <span className="font-mono text-xs text-muted-foreground">{item.vehicle.plate}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
          <span>{item.interventionType.nameIt}</span>
          <span className="flex items-center gap-1">
            {/* BR-101: when both dueDate and dueOdometerKm are set, the row */}
            {/* shows only the date. The km criterion is implicit and visible */}
            {/* on the vehicle detail page. */}
            {item.dueDate ? (
              <>
                <Calendar size={12} /> {formatDate(item.dueDate)}
              </>
            ) : (
              <>
                <Gauge size={12} /> {formatKm(item.dueOdometerKm)}
              </>
            )}
          </span>
          <span className="flex items-center gap-1">
            <User size={12} /> {customerName}
          </span>
        </div>
      </div>
    </button>
  );
}
