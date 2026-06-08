import { useNavigate } from 'react-router-dom';
import { Building2, Phone, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { customerDisplayName } from '@/lib/customer-display';
import type { Customer } from '@/queries/types';

export function CustomerResultCard({ customer }: { customer: Customer }) {
  const navigate = useNavigate();
  const href = `/customers/${customer.id}`;
  const Icon = customer.isBusiness ? Building2 : User;

  return (
    <button
      type="button"
      data-href={href}
      onClick={() => navigate(href)}
      className="w-full text-left bg-card border border-border rounded-lg p-4 flex items-center justify-between hover:border-blue-400 hover:bg-blue-50/30 dark:hover:bg-blue-950/30 dark:hover:border-blue-700 transition"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
          <Icon size={18} />
        </div>
        <div>
          <div className="font-semibold text-foreground">{customerDisplayName(customer)}</div>
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <Phone size={12} />
            {customer.phone ?? '—'}
          </div>
        </div>
      </div>
      {customer.isBusiness && <Badge variant="outline">Azienda</Badge>}
    </button>
  );
}
