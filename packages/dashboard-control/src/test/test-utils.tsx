/**
 * Test utilities for dashboard-control components and hooks.
 */

import { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';

// Mock store implementation for testing
export function createMockStore(initialState = {}) {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState: (newState: unknown) => {
      state = typeof newState === 'function' ? newState(state) : { ...state, ...newState };
      listeners.forEach((l) => l());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Wrapper component with custom providers
export function createTestWrapper(
  providers: Array<(props: { children: React.ReactNode }) => ReactElement> = []
) {
  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return providers.reduceRight(
      (acc, Provider) => <Provider>{acc}</Provider>,
      children
    );
  };
}

// Custom render function with optional providers
export function renderWithProviders(
  ui: ReactElement,
  options: Omit<RenderOptions, 'wrapper'> & {
    providers?: Array<(props: { children: React.ReactNode }) => ReactElement>;
  } = {}
) {
  const { providers = [], ...renderOptions } = options;
  const Wrapper = createTestWrapper(providers);
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

// Mock API response builders
export const mockApiResponse = {
  sessionRollup: (overrides = {}) => ({
    sessionKey: 'session-1234',
    title: 'Test Session',
    status: 'running',
    currentActivity: { tool: 'write', file: 'test.md' },
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }),
  focusData: (overrides = {}) => ({
    sessionKey: 'session-1234',
    header: { status: 'running', previewUrl: '' },
    packet: null,
    type: 'session',
    id: 'session-1234',
    ...overrides,
  }),
  markdownTreeNode: (overrides = {}) => ({
    type: 'file' as const,
    name: 'test.md',
    path: 'test.md',
    children: [],
    ...overrides,
  }),
  markdownTreeFolder: (overrides = {}) => ({
    type: 'folder' as const,
    name: 'folder',
    path: 'folder',
    children: [],
    ...overrides,
  }),
  cockpitEvent: (overrides = {}) => ({
    at: '2024-01-01T00:00:00Z',
    type: 'message',
    payload: { role: 'assistant', content: 'Test message' },
    isStatusOnly: false,
    ...overrides,
  }),
};

// Mock timers for debounced operations
export function setupMockTimers() {
  vi.useFakeTimers();
  return () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  };
}

// Wait for async operations
export const waitForAsync = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

// Keyboard event helpers
export function createKeyboardEvent(key: string, options: Partial<KeyboardEventInit> = {}) {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

// Mouse event helpers
export function createMouseEvent(
  type: string,
  options: Partial<MouseEventInit> = {}
) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 100,
    ...options,
  });
}

// Mock window.confirm
export function mockWindowConfirm(returns: boolean) {
  const original = window.confirm;
  window.confirm = vi.fn(() => returns);
  return () => {
    window.confirm = original;
  };
}

// Mock window.prompt
export function mockWindowPrompt(returns: string | null) {
  const original = window.prompt;
  window.prompt = vi.fn(() => returns);
  return () => {
    window.prompt = original;
  };
}

// Mock window.open
export function mockWindowOpen() {
  const original = window.open;
  const mockOpen = vi.fn(() => ({ name: 'test-window' }) as any);
  window.open = mockOpen;
  return {
    restore: () => {
      window.open = original;
    },
    getMock: () => mockOpen,
  };
}
