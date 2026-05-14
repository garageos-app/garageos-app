import { render, screen } from '@testing-library/react-native';
import { BadgeCertificato } from '@/components/BadgeCertificato';

describe('BadgeCertificato', () => {
  it('renders "Certificato" label for certificato variant', () => {
    render(<BadgeCertificato variant="certificato" />);
    expect(screen.getByText('Certificato')).toBeOnTheScreen();
  });

  it('renders "Privato" label for privato variant', () => {
    render(<BadgeCertificato variant="privato" />);
    expect(screen.getByText('Privato')).toBeOnTheScreen();
  });
});
