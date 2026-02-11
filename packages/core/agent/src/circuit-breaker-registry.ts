/**
 * CircuitBreakerRegistry - Centralized circuit breaker state management.
 *
 * Tracks circuit breaker state per provider, shared across all Agent instances.
 * Provides encapsulated access for testing and better separation of concerns.
 */

import { createCircuitState, type CircuitBreakerState } from 'llm';

/**
 * Registry for managing circuit breaker states per provider.
 * Singleton pattern - shared across all Agent instances.
 */
class CircuitBreakerRegistry {
  private states = new Map<string, CircuitBreakerState>();

  /**
   * Get or create circuit breaker state for a provider.
   */
  getState(provider: string): CircuitBreakerState {
    let state = this.states.get(provider);
    if (!state) {
      state = createCircuitState();
      this.states.set(provider, state);
    }
    return state;
  }

  /**
   * Reset circuit breaker state for a provider (e.g., after API key update).
   */
  reset(provider: string): void {
    this.states.delete(provider);
  }

  /**
   * Reset all circuit breaker states.
   */
  resetAll(): void {
    this.states.clear();
  }

  /**
   * Get current circuit breaker status for all providers.
   * Returns a copy to prevent external mutation.
   */
  getStatus(): Map<string, CircuitBreakerState> {
    return new Map(this.states);
  }

  /**
   * Check if a provider's circuit is currently open (blocking requests).
   */
  isOpen(provider: string): boolean {
    const state = this.states.get(provider);
    if (!state) return false;
    return state.state === 'open';
  }
}

// Singleton instance
export const circuitBreakerRegistry = new CircuitBreakerRegistry();

// Convenience exports for backwards compatibility
export function getProviderCircuitState(provider: string): CircuitBreakerState {
  return circuitBreakerRegistry.getState(provider);
}

export function resetProviderCircuit(provider: string): void {
  circuitBreakerRegistry.reset(provider);
}

export function getCircuitStatus(): Map<string, CircuitBreakerState> {
  return circuitBreakerRegistry.getStatus();
}
