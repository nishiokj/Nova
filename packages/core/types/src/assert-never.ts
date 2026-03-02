/**
 * Exhaustiveness helper for discriminated unions.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled case: ${String(value)}`);
}
