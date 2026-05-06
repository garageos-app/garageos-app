import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { DeadlineSection } from './DeadlineSection';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

function Wrap({ suggestsDeadline }: { suggestsDeadline: boolean }) {
  const methods = useForm<CreateInterventionFormValues>({
    defaultValues: {
      interventionTypeId: '00000000-0000-0000-0000-000000000000',
      interventionDate: '2025-12-01',
      odometerKm: 100000,
      description: 'Test intervention',
      partsReplaced: [],
      createDeadline: { enabled: suggestsDeadline, monthsFromNow: 12, kmIncrement: 15000 },
    },
  });
  return (
    <FormProvider {...methods}>
      <form>
        <DeadlineSection />
      </form>
    </FormProvider>
  );
}

describe('DeadlineSection', () => {
  it('shows toggle off by default when no defaults', () => {
    render(<Wrap suggestsDeadline={false} />);
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByLabelText(/mesi/i)).not.toBeInTheDocument();
  });

  it('shows months/km inputs when toggle on', async () => {
    render(<Wrap suggestsDeadline={true} />);
    expect(screen.getByLabelText(/mesi/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/incremento km/i)).toBeInTheDocument();
  });
});
