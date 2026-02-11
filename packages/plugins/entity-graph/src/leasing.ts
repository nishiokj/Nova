/**
 * File Leasing System
 *
 * Dual-layer coordination for multi-agent file access:
 * 1. In-memory Map — event loop is the mutex, zero-latency for same-process agents
 * 2. Postgres entity_graph.file_leases — durability across daemon restarts
 *
 * Waiting agents use a Promise-based queue with configurable timeout.
 */

import type { Sql } from 'postgres'

// --- In-Memory Layer ---

interface MemoryLease {
  agentId: string
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>
}

const memoryLeases = new Map<string, MemoryLease>()

// --- Public API ---

/**
 * Attempt to acquire a file lease.
 * If the file is already leased by another agent, waits up to `timeoutMs`
 * for it to be released.
 *
 * @returns true if the lease was acquired, false if timed out
 */
export async function acquireLease(
  sql: Sql,
  filepath: string,
  agentId: string,
  durationSec: number,
  timeoutMs: number = 10_000
): Promise<boolean> {
  // Check in-memory first
  const existing = memoryLeases.get(filepath)
  if (existing && existing.agentId && existing.agentId !== agentId) {
    // Another agent holds it — wait for release
    const released = await waitForRelease(filepath, timeoutMs)
    if (!released) return false
    // Re-check: another waiter may have acquired between wake and here
    const recheck = memoryLeases.get(filepath)
    if (recheck && recheck.agentId && recheck.agentId !== agentId) {
      return false
    }
  }

  // Acquire in-memory — preserve any queued waiters
  const current = memoryLeases.get(filepath)
  memoryLeases.set(filepath, { agentId, waiters: current?.waiters ?? [] })

  // Acquire in Postgres (for durability)
  try {
    const result = await sql`
      INSERT INTO entity_graph.file_leases (filepath, agent_id, acquired_at, expires_at)
      VALUES (${filepath}, ${agentId}, now(), now() + ${durationSec + ' seconds'}::interval)
      ON CONFLICT (filepath) DO UPDATE
        SET agent_id = EXCLUDED.agent_id,
            acquired_at = EXCLUDED.acquired_at,
            expires_at = EXCLUDED.expires_at
        WHERE entity_graph.file_leases.agent_id = ${agentId}
           OR entity_graph.file_leases.expires_at < now()
      RETURNING filepath
    `
    if (result.length === 0) {
      // DB lease held by another agent and not expired — release memory and fail
      memoryLeases.delete(filepath)
      return false
    }
  } catch {
    // DB failure — still hold memory lease (best-effort durability)
  }

  return true
}

/**
 * Release a file lease.
 * Deletes both in-memory and Postgres records, then wakes waiting agents.
 */
export async function releaseLease(
  sql: Sql,
  filepath: string,
  agentId: string
): Promise<void> {
  // Release in-memory and wake waiters
  const lease = memoryLeases.get(filepath)
  if (lease && lease.agentId === agentId) {
    const first = lease.waiters.shift()
    if (first) {
      // Clear holder but keep entry with remaining waiters
      lease.agentId = ''
      first.resolve()
    } else {
      memoryLeases.delete(filepath)
    }
  }

  // Release in Postgres
  try {
    await sql`
      DELETE FROM entity_graph.file_leases
      WHERE filepath = ${filepath} AND agent_id = ${agentId}
    `
  } catch {
    // Best-effort — memory lease already released
  }
}

/**
 * Clean up expired leases from Postgres.
 * Returns the number of leases cleaned.
 */
export async function cleanExpiredLeases(sql: Sql): Promise<number> {
  const result = await sql`
    DELETE FROM entity_graph.file_leases
    WHERE expires_at < now()
  `
  return result.count
}

/**
 * Check if a file is currently leased (in-memory check only).
 */
export function isLeased(filepath: string): boolean {
  return memoryLeases.has(filepath)
}

/**
 * Get the agent holding a lease on a file (in-memory).
 */
export function leaseHolder(filepath: string): string | null {
  return memoryLeases.get(filepath)?.agentId ?? null
}

/**
 * Clear all in-memory leases. For testing.
 */
export function clearMemoryLeases(): void {
  memoryLeases.clear()
}

// --- Internal ---

/**
 * Wait for a file lease to be released, with timeout.
 * Returns true if the lease was released, false if timed out.
 */
function waitForRelease(filepath: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const lease = memoryLeases.get(filepath)
    if (!lease) {
      resolve(true)
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        // Remove our waiter from the list
        const idx = lease.waiters.findIndex(w => w.resolve === onRelease)
        if (idx >= 0) lease.waiters.splice(idx, 1)
        resolve(false)
      }
    }, timeoutMs)

    function onRelease() {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(true)
      }
    }

    function onReject() {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(false)
      }
    }

    lease.waiters.push({ resolve: onRelease, reject: onReject })
  })
}
