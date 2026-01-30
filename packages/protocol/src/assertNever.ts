/**
 * Exhaustiveness helper for discriminated unions.
 * Use in default branches to force compile-time coverage.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled case: ${String(value)}`);
}
