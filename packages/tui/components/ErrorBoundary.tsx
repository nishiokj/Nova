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

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to stderr for debugging
    console.error('TUI render error:', error.message);
    console.error('Component stack:', info.componentStack);
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
