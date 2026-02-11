import React, { Component, type ReactNode } from 'react';
import { Box, Text } from 'ink';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary for the TUI.
 * Catches render errors that would otherwise crash the entire app.
 * Shows a fallback UI and allows recovery.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(_error: Error, _info: React.ErrorInfo): void {
    // Error is captured in state and shown in fallback UI.
    // Do NOT use console.error here - it breaks Ink's rendering
    // and causes flickering. The error boundary displays the error
    // in the UI, which is sufficient for user visibility.
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>UI Error</Text>
          <Text color="gray">{this.state.error?.message ?? 'Unknown error'}</Text>
          <Text> </Text>
          <Text>Press Ctrl+C to exit, or the UI will attempt recovery...</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
