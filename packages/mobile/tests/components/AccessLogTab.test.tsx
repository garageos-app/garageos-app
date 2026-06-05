import { render, screen, fireEvent } from '@testing-library/react-native';
import { AccessLogTab } from '@/components/AccessLogTab';
import type { CustomerAccessEntry } from '@/lib/types/accessLog';

const entry: CustomerAccessEntry = {
  action: 'view',
  tenantName: 'Officina Rossi',
  locationCity: 'Torino',
  occurredAt: '2026-06-05T12:32:00.000Z',
};

const baseProps = {
  entries: [entry],
  isLoading: false,
  isError: false,
  errorCode: undefined as string | undefined,
  onRetry: () => {},
  hasNextPage: false,
  isFetchingNextPage: false,
  onLoadMore: () => {},
};

describe('AccessLogTab', () => {
  it('renders the access rows', () => {
    render(<AccessLogTab {...baseProps} />);
    expect(screen.getByText('Consultazione libretto')).toBeOnTheScreen();
  });

  it('shows the empty state when there are no entries', () => {
    render(<AccessLogTab {...baseProps} entries={[]} />);
    expect(screen.getByText('Nessun accesso registrato')).toBeOnTheScreen();
  });

  it('shows the loading skeleton when loading', () => {
    render(<AccessLogTab {...baseProps} isLoading entries={[]} />);
    expect(screen.getByLabelText('Caricamento elenco')).toBeOnTheScreen();
  });

  it('shows the error state with a retry that fires onRetry', () => {
    const onRetry = jest.fn();
    render(
      <AccessLogTab {...baseProps} isError errorCode="me.error" entries={[]} onRetry={onRetry} />,
    );
    fireEvent.press(screen.getByText('Riprova'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows Carica altri when hasNextPage and fires onLoadMore', () => {
    const onLoadMore = jest.fn();
    render(<AccessLogTab {...baseProps} hasNextPage onLoadMore={onLoadMore} />);
    fireEvent.press(screen.getByText('Carica altri'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('hides Carica altri when there is no next page', () => {
    render(<AccessLogTab {...baseProps} hasNextPage={false} />);
    expect(screen.queryByText('Carica altri')).toBeNull();
  });

  it('hides the Carica altri label while fetching the next page', () => {
    render(<AccessLogTab {...baseProps} hasNextPage isFetchingNextPage />);
    expect(screen.queryByText('Carica altri')).toBeNull();
  });
});
