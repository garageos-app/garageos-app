import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Minimal Progress bar — shadcn-compatible API without @radix-ui/react-progress.
 * Wraps a <div role="progressbar"> so the outer consumer can omit the role.
 * The aria-* attributes are NOT set here; callers that need them should wrap
 * this component in their own div[role="progressbar"] with aria-valuenow etc.
 */
const Progress = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { value?: number }
>(({ className, value = 0, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    {...props}
  >
    <div
      className="h-full w-full flex-1 bg-primary transition-all"
      style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value))}%)` }}
    />
  </div>
));
Progress.displayName = 'Progress';

export { Progress };
