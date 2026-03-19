/**
 * Contract Challenge & Acknowledgement — red team verification layer.
 *
 * Manages challenges (red team disputes) and acknowledgements (red team
 * confirmation that proofs are sufficient). Acknowledgements are invalidated
 * when a referenced test fails.
 */

import { randomUUID } from 'crypto'
import type { Sql } from 'postgres'
import type { ContractChallenge, ContractAcknowledgement } from './types.js'

// --- Challenge CRUD ---

export async function createChallenge(
  sql: Sql,
  contractId: string,
  conditionId: string | null,
  argument: string,
  evidence?: string,
): Promise<ContractChallenge> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await sql`
    INSERT INTO entity_graph.contract_challenges
      (id, contract_id, condition_id, argument, evidence, status, submitted_at)
    VALUES (${id}, ${contractId}, ${conditionId}, ${argument}, ${evidence ?? null}, 'open', ${now})
  `
  return {
    id,
    contractId,
    conditionId,
    argument,
    evidence: evidence ?? null,
    status: 'open',
    submittedAt: now,
    resolvedAt: null,
  }
}

export async function challengesForContract(
  sql: Sql,
  contractId: string,
): Promise<ContractChallenge[]> {
  const rows = await sql<Array<{
    id: string; contract_id: string; condition_id: string | null
    argument: string; evidence: string | null; status: string
    submitted_at: string; resolved_at: string | null
  }>>`
    SELECT * FROM entity_graph.contract_challenges
    WHERE contract_id = ${contractId}
    ORDER BY submitted_at DESC
  `
  return rows.map(r => ({
    id: r.id,
    contractId: r.contract_id,
    conditionId: r.condition_id,
    argument: r.argument,
    evidence: r.evidence,
    status: r.status as ContractChallenge['status'],
    submittedAt: r.submitted_at,
    resolvedAt: r.resolved_at,
  }))
}

export async function openChallengesForContract(
  sql: Sql,
  contractId: string,
): Promise<ContractChallenge[]> {
  const rows = await sql<Array<{
    id: string; contract_id: string; condition_id: string | null
    argument: string; evidence: string | null; status: string
    submitted_at: string; resolved_at: string | null
  }>>`
    SELECT * FROM entity_graph.contract_challenges
    WHERE contract_id = ${contractId} AND status = 'open'
    ORDER BY submitted_at DESC
  `
  return rows.map(r => ({
    id: r.id,
    contractId: r.contract_id,
    conditionId: r.condition_id,
    argument: r.argument,
    evidence: r.evidence,
    status: r.status as ContractChallenge['status'],
    submittedAt: r.submitted_at,
    resolvedAt: r.resolved_at,
  }))
}

export async function resolveChallenge(
  sql: Sql,
  challengeId: string,
  resolution: 'addressed' | 'dismissed',
): Promise<void> {
  const now = new Date().toISOString()
  await sql`
    UPDATE entity_graph.contract_challenges
    SET status = ${resolution}, resolved_at = ${now}
    WHERE id = ${challengeId}
  `
}

// --- Acknowledgement CRUD ---

export async function createAcknowledgement(
  sql: Sql,
  contractId: string,
): Promise<ContractAcknowledgement> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await sql`
    INSERT INTO entity_graph.contract_acknowledgements
      (id, contract_id, submitted_at)
    VALUES (${id}, ${contractId}, ${now})
  `
  return {
    id,
    contractId,
    submittedAt: now,
    invalidatedAt: null,
    invalidatedReason: null,
  }
}

export async function activeAcknowledgement(
  sql: Sql,
  contractId: string,
): Promise<ContractAcknowledgement | null> {
  const [row] = await sql<Array<{
    id: string; contract_id: string; submitted_at: string
    invalidated_at: string | null; invalidated_reason: string | null
  }>>`
    SELECT * FROM entity_graph.contract_acknowledgements
    WHERE contract_id = ${contractId} AND invalidated_at IS NULL
    ORDER BY submitted_at DESC
    LIMIT 1
  `
  if (!row) return null
  return {
    id: row.id,
    contractId: row.contract_id,
    submittedAt: row.submitted_at,
    invalidatedAt: row.invalidated_at,
    invalidatedReason: row.invalidated_reason,
  }
}

export async function invalidateAcknowledgement(
  sql: Sql,
  contractId: string,
  reason: string,
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await sql`
    UPDATE entity_graph.contract_acknowledgements
    SET invalidated_at = ${now}, invalidated_reason = ${reason}
    WHERE contract_id = ${contractId} AND invalidated_at IS NULL
  `
  return result.count > 0
}

export async function acknowledgementHistory(
  sql: Sql,
  contractId: string,
): Promise<ContractAcknowledgement[]> {
  const rows = await sql<Array<{
    id: string; contract_id: string; submitted_at: string
    invalidated_at: string | null; invalidated_reason: string | null
  }>>`
    SELECT * FROM entity_graph.contract_acknowledgements
    WHERE contract_id = ${contractId}
    ORDER BY submitted_at DESC
  `
  return rows.map(r => ({
    id: r.id,
    contractId: r.contract_id,
    submittedAt: r.submitted_at,
    invalidatedAt: r.invalidated_at,
    invalidatedReason: r.invalidated_reason,
  }))
}
