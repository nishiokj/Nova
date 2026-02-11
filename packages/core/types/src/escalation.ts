/**
 * Escalation Types
 *
 * The atomic unit of "needs human attention" - the only genuinely new
 * stateful entity for the Cockpit control plane.
 *
 * Escalations have a lifecycle: pending → acknowledged → resolved | dismissed
 */

// ============================================
// ESCALATION TYPE
// ============================================

/**
 * Classification of what kind of decision is needed.
 */
export type EscalationType =
  | 'architectural' // Observer-driven design decision
  | 'uncertainty' // Agent not confident
  | 'permission' // Needs approval for action
  | 'conflict' // Invariant or preference conflict
  | 'review' // PR/code ready for review
  | 'failure' // Unrecoverable error
  | 'resource'; // Budget/time threshold hit

/**
 * Escalation lifecycle status.
 *
 * Transitions:
 *   ∅ → pending (created)
 *   pending → acknowledged (UI opened)
 *   pending → resolved (human provides answer)
 *   pending → dismissed (human dismisses without answer)
 *   resolved is terminal
 *   dismissed is terminal
 */
export type EscalationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

// ============================================
// ESCALATION OPTION
// ============================================

/**
 * A pre-defined option for resolving an escalation.
 * Observer can suggest options with implications.
 */
export interface EscalationOption {
  /** Unique ID for this option (e.g., 'jwt', 'opaque', 'option-1') */
  id: string;
  /** Human-readable label */
  label: string;
  /** Detailed description of what this option means */
  description: string;
  /** What happens if this option is chosen */
  implications: string[];
  /** Whether this is the recommended option */
  recommended: boolean;
}

// ============================================
// ESCALATION REFERENCE
// ============================================

/**
 * Reference to supporting evidence for an escalation.
 */
export interface EscalationReference {
  /** Type of reference */
  type: 'file' | 'diff' | 'commit' | 'decision' | 'workitem' | 'message';
  /** Human-readable label */
  label: string;
  /** Target path, SHA, or ID depending on type */
  target: string;
  /** Optional snippet for inline display */
  preview?: string;
}

// ============================================
// ESCALATION RESOLUTION
// ============================================

/**
 * How an escalation was resolved.
 */
export interface EscalationResolution {
  /** Selected option ID (if options were provided) */
  optionId?: string;
  /** Free-form text response (if no option selected or additional context) */
  freeformResponse?: string;
  /** Who resolved this escalation */
  resolvedBy: 'user' | 'system' | 'timeout';
}

// ============================================
// ESCALATION
// ============================================

/**
 * Escalation - the atomic unit of "needs human attention".
 *
 * This is the only genuinely new stateful entity in the Cockpit.
 * Everything else (Session, WorkItem) existed before.
 */
export interface Escalation {
  /** Unique ID (ULID) */
  id: string;
  /** Classification of the escalation */
  type: EscalationType;
  /** Current lifecycle status */
  status: EscalationStatus;

  // Context
  /** Session this escalation belongs to */
  sessionKey: string;
  /** Specific work item (if applicable) */
  workItemId?: string;

  // Content
  /** One-line summary */
  title: string;
  /** Rich markdown context explaining the situation */
  context: string;
  /** Trade-offs for architectural decisions */
  tradeoffs?: string[];
  /** Pre-defined resolution options */
  options?: EscalationOption[];

  // Evidence
  /** Supporting references */
  references: EscalationReference[];

  // Resolution
  /** When resolved (timestamp) */
  resolvedAt?: number;
  /** Resolution details */
  resolution?: EscalationResolution;

  // Timestamps
  /** When created */
  createdAt: number;
  /** Last updated */
  updatedAt: number;
}

// ============================================
// ESCALATION CREATE INPUT
// ============================================

/**
 * Input for creating a new escalation.
 * Omits auto-generated fields (id, status, timestamps).
 */
export interface EscalationCreateInput {
  type: EscalationType;
  sessionKey: string;
  workItemId?: string;
  title: string;
  context: string;
  tradeoffs?: string[];
  options?: EscalationOption[];
  references?: EscalationReference[];
}

// ============================================
// ESCALATION RESOLVE INPUT
// ============================================

/**
 * Input for resolving an escalation.
 */
export interface EscalationResolveInput {
  /** Selected option ID (if options were provided) */
  optionId?: string;
  /** Free-form text response */
  freeformResponse?: string;
}

// ============================================
// TYPE GUARDS
// ============================================

/**
 * Check if an escalation is pending (can be resolved).
 */
export function isEscalationPending(escalation: Escalation): boolean {
  return escalation.status === 'pending' || escalation.status === 'acknowledged';
}

/**
 * Check if an escalation is terminal (resolved or dismissed).
 */
export function isEscalationTerminal(escalation: Escalation): boolean {
  return escalation.status === 'resolved' || escalation.status === 'dismissed';
}

/**
 * Check if an escalation is blocking its session.
 */
export function isEscalationBlocking(escalation: Escalation): boolean {
  return escalation.status === 'pending';
}

// ============================================
// CONSTANTS
// ============================================

/**
 * All escalation types.
 */
export const ALL_ESCALATION_TYPES: readonly EscalationType[] = [
  'architectural',
  'uncertainty',
  'permission',
  'conflict',
  'review',
  'failure',
  'resource',
] as const;

/**
 * All escalation statuses.
 */
export const ALL_ESCALATION_STATUSES: readonly EscalationStatus[] = [
  'pending',
  'acknowledged',
  'resolved',
  'dismissed',
] as const;
