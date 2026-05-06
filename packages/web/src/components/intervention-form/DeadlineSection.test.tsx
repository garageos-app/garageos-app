import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { DeadlineSection } from './DeadlineSection';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

function Wrap({ suggestsDeadline }: { suggestsDeadline: boolean }) {
  const methods = useForm<CreateInterventionFormValues>({
    defaultValues: {
      partsReplaced: [],
      createDeadline: { enabled: suggestsDeadline, monthsFromNow: 12, kmIncrement: 15000 },
    } as CreateInterventionFormValues,
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
