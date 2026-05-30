import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { DeadlineSection } from './DeadlineSection';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';
import type { DeadlineSuggestion } from '@/lib/deadline-suggestion';

function Wrap({
  enabled,
  suggestion,
}: {
  enabled: boolean;
  suggestion?: DeadlineSuggestion | null;
}) {
  const methods = useForm<CreateInterventionFormValues>({
    defaultValues: {
      interventionTypeId: '00000000-0000-0000-0000-000000000000',
      interventionDate: '2025-12-01',
      odometerKm: 100000,
      description: 'Test intervention',
      partsReplaced: [],
      createDeadline: { enabled, monthsFromNow: 12, kmIncrement: 15000 },
    },
  });
  return (
    <FormProvider {...methods}>
      <form>
        <DeadlineSection {...(suggestion !== undefined ? { suggestion } : {})} />
      </form>
    </FormProvider>
  );
}

describe('DeadlineSection', () => {
  it('shows toggle off by default when no defaults', () => {
    render(<Wrap enabled={false} />);
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByLabelText(/mesi/i)).not.toBeInTheDocument();
  });

  it('shows months/km inputs when toggle on', () => {
    render(<Wrap enabled={true} />);
    expect(screen.getByLabelText(/mesi/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/incremento km/i)).toBeInTheDocument();
  });

  it('renders the suggestion line when a suggestion is provided', () => {
    render(<Wrap enabled={true} suggestion={{ typeName: 'Tagliando', months: 12, km: 15000 }} />);
    expect(
      screen.getByText('Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi.'),
    ).toBeInTheDocument();
  });

  it('renders no suggestion line when no suggestion is provided', () => {
    render(<Wrap enabled={true} />);
    expect(screen.queryByText(/suggerito per/i)).not.toBeInTheDocument();
  });
});
