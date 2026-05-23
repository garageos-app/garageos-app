import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export type CardShellState = 'loading' | 'empty' | 'error' | 'data';

interface Props {
  title: string;
  count?: number;
  countBadgeVariant?: 'default' | 'destructive';
  state: CardShellState;
  emptyText: string;
  errorText: string;
  children: React.ReactNode;
}

export function CardShell({
  title,
  count,
  countBadgeVariant = 'default',
  state,
  emptyText,
  errorText,
  children,
}: Props) {
  return (
    <Card className="p-4 flex flex-col gap-3 min-h-[280px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {typeof count === 'number' && count > 0 && (
          <Badge variant={countBadgeVariant} data-testid="cardshell-count-badge">
            {count}
          </Badge>
        )}
      </div>
      <div className="flex-1 flex flex-col">
        {state === 'loading' && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} data-testid="cardshell-loading-row" className="h-6 w-full" />
            ))}
          </div>
        )}
        {state === 'empty' && (
          <p className="text-sm text-muted-foreground text-center my-auto">{emptyText}</p>
        )}
        {state === 'error' && (
          <p className="text-sm text-destructive text-center my-auto">{errorText}</p>
        )}
        {state === 'data' && children}
      </div>
    </Card>
  );
}
