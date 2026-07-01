import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
}

export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
      {Icon && (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
