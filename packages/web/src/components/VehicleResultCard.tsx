import { useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fallback } from '@/lib/format';
import type { VehicleSearchItem } from '@/queries/types';

const statusBadge: Record<
  VehicleSearchItem['status'],
  { label: string; cls: string; Icon: typeof CheckCircle2 }
> = {
  certified: {
    label: 'Certificato',
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    Icon: CheckCircle2,
  },
  pending: { label: 'Pending', cls: 'bg-amber-50 text-amber-700 border-amber-200', Icon: Clock },
  disputed: {
    label: 'Contestato',
    cls: 'bg-red-50 text-red-700 border-red-200',
    Icon: AlertTriangle,
  },
};

export function VehicleResultCard({ vehicle }: { vehicle: VehicleSearchItem }) {
  const navigate = useNavigate();
  const customerName = vehicle.currentOwnership?.customer
    ? `${fallback(vehicle.currentOwnership.customer.firstName)} ${fallback(vehicle.currentOwnership.customer.lastName)}`.trim()
    : '—';
  const sb = statusBadge[vehicle.status];

  return (
    <button
      type="button"
      onClick={() => navigate(`/vehicles/${vehicle.id}`)}
      className="w-full text-left bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between hover:border-blue-400 hover:bg-blue-50/30 transition"
    >
      <div className="flex-1">
        <div className="font-mono text-sm font-semibold text-slate-900 tracking-wider">
          {vehicle.garageCode}
        </div>
        <div className="text-base mt-1">
          {vehicle.make} {vehicle.model}{' '}
          <span className="text-slate-500">
            · {vehicle.plate} · {vehicle.year} · {vehicle.fuelType}
          </span>
        </div>
        <div className="text-xs text-slate-500 mt-1.5">
          👤 {customerName === '— —' ? '—' : customerName}
        </div>
      </div>
      <Badge variant="outline" className={sb.cls}>
        <sb.Icon size={12} className="mr-1" /> {sb.label}
      </Badge>
    </button>
  );
}
