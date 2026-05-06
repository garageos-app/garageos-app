import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { PartsRepeater } from './PartsRepeater';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

function Wrap({ defaultValues }: { defaultValues?: Partial<CreateInterventionFormValues> }) {
  const methods = useForm<CreateInterventionFormValues>({
    defaultValues: { partsReplaced: [], ...(defaultValues ?? {}) } as CreateInterventionFormValues,
  });
  return (
    <FormProvider {...methods}>
      <form>
        <PartsRepeater />
      </form>
    </FormProvider>
  );
}

describe('PartsRepeater', () => {
  it('renders empty state with add button', () => {
    render(<Wrap />);
    expect(screen.getByRole('button', { name: /aggiungi pezzo/i })).toBeInTheDocument();
  });

  it('adds a row when "Aggiungi pezzo" clicked', async () => {
    render(<Wrap />);
    await userEvent.click(screen.getByRole('button', { name: /aggiungi pezzo/i }));
    expect(screen.getByPlaceholderText(/nome pezzo/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/quantità/i)).toBeInTheDocument();
  });

  it('removes a row when delete clicked', async () => {
    render(<Wrap defaultValues={{ partsReplaced: [{ name: 'Olio', quantity: 4 }] }} />);
    expect(screen.getByDisplayValue('Olio')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /rimuovi pezzo 1/i }));
    expect(screen.queryByDisplayValue('Olio')).not.toBeInTheDocument();
  });
});
