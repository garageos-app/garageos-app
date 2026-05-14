import { Component, type ReactNode } from 'react';
import * as Updates from 'expo-updates';
import { ErrorState } from './ErrorState';

type Props = { children: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    // Dev: red-box overlay handles. Prod: Sentry deferred to follow-up PR.
    console.error('[ErrorBoundary]', error);
  }

  private reload = async (): Promise<void> => {
    try {
      await Updates.reloadAsync();
    } catch {
      this.setState({ hasError: false });
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorState message="Errore imprevisto. Riavvia l'app." onRetry={this.reload} />;
    }
    return this.props.children;
  }
}
