import { ScadenzeCard } from '@/components/dashboard/ScadenzeCard';
import { InterventionsCard } from '@/components/dashboard/InterventionsCard';
import { PlaceholderCard } from '@/components/dashboard/PlaceholderCard';

export function HomeDashboard() {
  return (
    <div className="p-6">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_0.6fr] gap-4">
        <ScadenzeCard />
        <InterventionsCard />
        <PlaceholderCard title="Contestazioni" />
      </div>
    </div>
  );
}
