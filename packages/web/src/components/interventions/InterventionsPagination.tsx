// IT-strings — hardcoded, no i18n in this app
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PAGE_SIZE } from '@/queries/interventionsList';

export interface InterventionsPaginationProps {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function InterventionsPagination({
  page,
  total,
  onPageChange,
}: InterventionsPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex items-center justify-between gap-4 pt-3 text-sm">
      <span className="text-muted-foreground">{total} interventi</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label="Pagina precedente"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </Button>
        <span className="tabular-nums">
          Pagina {page} di {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-label="Pagina successiva"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
}
