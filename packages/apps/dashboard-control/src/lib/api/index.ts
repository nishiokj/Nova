/**
 * Control Plane API Client — barrel re-export.
 *
 * All existing `import { ... } from '@/lib/api'` continue to work unchanged.
 * Consumers may also import from specific sub-modules for clarity.
 */

export * from './types';
export * from './fetch';
export * from './rollups';
export * from './sessions';
export * from './markdown';
export * from './browser';
export * from './repo';
export * from './escalations';
export * from './legacy';
export * from './autocomplete';
