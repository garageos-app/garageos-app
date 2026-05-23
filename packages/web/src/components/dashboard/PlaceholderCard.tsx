import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  title: string;
}

export function PlaceholderCard({ title }: Props) {
  return (
    <Card className="p-4 flex flex-col gap-3 min-h-[280px]">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="flex flex-col gap-2 flex-1">
        {[0, 1, 2].map((i) => (
          <Skeleton
            key={i}
            data-testid="placeholder-skeleton-row"
            className="h-6 w-full opacity-50"
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground italic text-center mt-2">
        In arrivo nel prossimo PR
      </p>
    </Card>
  );
}
