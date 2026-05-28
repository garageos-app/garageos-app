import { ScadenzeCard } from '@/components/dashboard/ScadenzeCard';
import { InterventionsCard } from '@/components/dashboard/InterventionsCard';
import { DisputesCard } from '@/components/dashboard/DisputesCard';
import { DisputeBanner } from '@/components/dashboard/DisputeBanner';

export function HomeDashboard() {
  return (
    <div className="p-6">
      <h1 className="sr-only">Home</h1>
      <DisputeBanner />
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_0.6fr] gap-4">
        <ScadenzeCard />
        <InterventionsCard />
        <div id="disputes-card">
          <DisputesCard />
        </div>
      </div>
    </div>
  );
}
