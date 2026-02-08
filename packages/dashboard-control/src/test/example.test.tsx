import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('Vitest Setup Verification', () => {
  it('should run basic test', () => {
    expect(1 + 1).toBe(2);
  });

  it('should render a simple component', () => {
    const TestComponent = () => <div>Hello, World!</div>;
    render(<TestComponent />);
    expect(screen.getByText('Hello, World!')).toBeInTheDocument();
  });

  it('should have jest-dom matchers available', () => {
    const TestComponent = () => (
      <button type="button" disabled>
        Click me
      </button>
    );
    render(<TestComponent />);
    const button = screen.getByRole('button', { name: 'Click me' });
    expect(button).toBeDisabled();
  });

  it('should have vi mock available', () => {
    const mockFn = vi.fn();
    mockFn('test');
    expect(mockFn).toHaveBeenCalledWith('test');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});
