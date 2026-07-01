import type { ReactNode } from 'react';

interface PageHeaderProps {
  // Contextual title only (e.g. an entity name). The page-type title lives in
  // the Topbar; do NOT pass it here or it will duplicate.
  title?: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  if (!title && !description && !actions) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        {title && <h2 className="text-xl font-semibold tracking-tight">{title}</h2>}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
