import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisputeBanner } from './DisputeBanner';
import { useDisputesOpen } from '@/queries/disputesOpen';

vi.mock('@/queries/disputesOpen');

const mockedUseDisputesOpen = vi.mocked(useDisputesOpen);

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DisputeBanner />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('<DisputeBanner />', () => {
  it('renders null when pendingCount = 0', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: { count: 5, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });

  it('renders null while loading', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as never);
    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });

  it('renders banner with singular text when pendingCount = 1', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 1, items: [] },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderBanner();
    const banner = screen.getByTestId('dispute-banner');
    expect(banner).toHaveTextContent('1 contestazione in attesa di risposta');
    expect(banner).toHaveTextContent('apri elenco');
  });

  it('renders banner with plural text when pendingCount > 1', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 3, items: [] },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderBanner();
    expect(screen.getByTestId('dispute-banner')).toHaveTextContent(
      '3 contestazioni in attesa di risposta',
    );
  });

  it('has destructive variant + sticky top class', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 1, items: [] },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderBanner();
    const banner = screen.getByTestId('dispute-banner');
    expect(banner.className).toMatch(/destructive/);
    expect(banner.className).toMatch(/sticky/);
    expect(banner.className).toMatch(/top-14/);
  });
});
