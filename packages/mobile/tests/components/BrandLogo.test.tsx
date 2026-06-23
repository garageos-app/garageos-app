import { render } from '@testing-library/react-native';
import { BrandLogo } from '@/components/BrandLogo';

describe('BrandLogo', () => {
  it('renders the GarageOS wordmark by default', () => {
    const { getByText } = render(<BrandLogo tone="onLight" />);
    expect(getByText('GarageOS')).toBeTruthy();
  });

  it('renders the tagline when provided', () => {
    const { getByText } = render(
      <BrandLogo tone="onDark" tagline="Il libretto digitale del tuo veicolo" />,
    );
    expect(getByText('Il libretto digitale del tuo veicolo')).toBeTruthy();
  });

  it('omits the wordmark when showWordmark is false', () => {
    const { queryByText } = render(<BrandLogo tone="onLight" showWordmark={false} />);
    expect(queryByText('GarageOS')).toBeNull();
  });
});
