import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardShell } from './CardShell';

const baseProps = {
  title: 'Test card',
  emptyText: 'Niente da mostrare',
  errorText: 'Errore di caricamento',
};

describe('<CardShell />', () => {
  it('renders title in header', () => {
    render(
      <CardShell {...baseProps} state="data">
        <div>body</div>
      </CardShell>,
    );
    expect(screen.getByRole('heading', { name: 'Test card' })).toBeInTheDocument();
  });

  it('renders count badge when count provided and >0', () => {
    render(
      <CardShell {...baseProps} state="data" count={5}>
        <div />
      </CardShell>,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('does not render count badge when count is 0', () => {
    render(
      <CardShell {...baseProps} state="empty" count={0}>
        <div />
      </CardShell>,
    );
    expect(screen.queryByTestId('cardshell-count-badge')).not.toBeInTheDocument();
  });

  it('renders skeleton rows when state is loading (no children)', () => {
    const { container } = render(
      <CardShell {...baseProps} state="loading">
        <div data-testid="should-not-render" />
      </CardShell>,
    );
    expect(
      container.querySelectorAll('[data-testid="cardshell-loading-row"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId('should-not-render')).not.toBeInTheDocument();
  });

  it('renders empty text when state is empty (no children)', () => {
    render(
      <CardShell {...baseProps} state="empty">
        <div data-testid="should-not-render" />
      </CardShell>,
    );
    expect(screen.getByText('Niente da mostrare')).toBeInTheDocument();
    expect(screen.queryByTestId('should-not-render')).not.toBeInTheDocument();
  });

  it('renders error text when state is error', () => {
    render(
      <CardShell {...baseProps} state="error">
        <div data-testid="should-not-render" />
      </CardShell>,
    );
    expect(screen.getByText('Errore di caricamento')).toBeInTheDocument();
    expect(screen.queryByTestId('should-not-render')).not.toBeInTheDocument();
  });

  it('renders children only when state is data', () => {
    render(
      <CardShell {...baseProps} state="data">
        <div data-testid="card-body">body</div>
      </CardShell>,
    );
    expect(screen.getByTestId('card-body')).toBeInTheDocument();
  });
});
