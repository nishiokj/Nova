/**
 * Protocol Version - Schema Compatibility
 *
 * Tracks schema versions for compatibility checking.
 */

import { createHash } from 'crypto';
import {
  TerminationReasonSchema,
  QualityGateDecisionSchema,
  BoundsDecisionSchema,
  PromptAnswerDecisionSchema,
  CadenceDecisionSchema,
  AgentErrorDecisionSchema,
  WorkItemCompletedDecisionSchema,
  StatePatchSchema,
} from './schemas.js';

// ============================================
// VERSION TRACKING
// ============================================

/**
 * Semantic version of the protocol.
 */
export const PROTOCOL_VERSION = '1.0.0';

/**
 * Compute a hash of all schemas for compatibility checking.
 */
export function computeSchemaHash(): string {
  const schemas = [
    TerminationReasonSchema,
    QualityGateDecisionSchema,
    BoundsDecisionSchema,
    PromptAnswerDecisionSchema,
    CadenceDecisionSchema,
    AgentErrorDecisionSchema,
    WorkItemCompletedDecisionSchema,
    StatePatchSchema,
  ];

  // Use schema shapes as the basis for the hash
  const schemaStrings = schemas.map(s => JSON.stringify(s._def));
  const combined = schemaStrings.join('|');

  return createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

/**
 * Current schema hash (computed at module load).
 */
export const SCHEMA_HASH = computeSchemaHash();

// ============================================
// COMPATIBILITY
// ============================================

/**
 * Protocol identifier combining version and hash.
 */
export function getProtocolId(): string {
  return `protocol:${PROTOCOL_VERSION}:${SCHEMA_HASH}`;
}

/**
 * Check if a protocol ID is compatible with current.
 */
export function isCompatible(protocolId: string): boolean {
  const [name, version, hash] = protocolId.split(':');

  if (name !== 'protocol') {
    return false;
  }

  // Same major version is compatible
  const [major] = version.split('.');
  const [currentMajor] = PROTOCOL_VERSION.split('.');

  if (major !== currentMajor) {
    return false;
  }

  // Hash mismatch is a warning, not incompatibility
  if (hash !== SCHEMA_HASH) {
    console.warn(`Schema hash mismatch: ${hash} vs ${SCHEMA_HASH}`);
  }

  return true;
}

// ============================================
// MIGRATION HELPERS
// ============================================

/**
 * Known schema migrations.
 */
const MIGRATIONS: Record<string, (data: unknown) => unknown> = {
  // Example: migrate from 0.x to 1.x
  // '0.x_to_1.0': (data) => { ... }
};

/**
 * Migrate data from an older protocol version.
 */
export function migrateData(
  data: unknown,
  fromVersion: string,
  toVersion: string = PROTOCOL_VERSION
): unknown {
  const migrationKey = `${fromVersion}_to_${toVersion}`;
  const migration = MIGRATIONS[migrationKey];

  if (!migration) {
    throw new Error(`No migration path from ${fromVersion} to ${toVersion}`);
  }

  return migration(data);
}

/**
 * Check if migration is available.
 */
export function hasMigration(fromVersion: string, toVersion: string = PROTOCOL_VERSION): boolean {
  return `${fromVersion}_to_${toVersion}` in MIGRATIONS;
}
