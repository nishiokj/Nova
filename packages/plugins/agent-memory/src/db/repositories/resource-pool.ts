/**
 * Resource Pool Repository
 *
 * Manages shared resource pools for rate limiting and budget management.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export interface ResourcePool {
  id: string
  name: string
  max_concurrent: number
  requests_per_minute: number | null
  daily_budget_cents: number | null
  current_spend_cents: number
  budget_reset_at: string | null
  created_at: string
  updated_at: string
}

export interface ResourcePoolRow {
  id: string
  name: string
  max_concurrent: number
  requests_per_minute: number | null
  daily_budget_cents: number | null
  current_spend_cents: number
  budget_reset_at: Date | null
  created_at: Date
  updated_at: Date
}

function rowToResourcePool(row: ResourcePoolRow): ResourcePool {
  return {
    id: row.id,
    name: row.name,
    max_concurrent: row.max_concurrent,
    requests_per_minute: row.requests_per_minute,
    daily_budget_cents: row.daily_budget_cents,
    current_spend_cents: row.current_spend_cents,
    budget_reset_at: row.budget_reset_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface ResourcePoolInput {
  name: string
  maxConcurrent?: number
  requestsPerMinute?: number
  dailyBudgetCents?: number
}

export interface CanAcquireResult {
  allowed: boolean
  reason?: string
  retryAfter?: number
}

export interface ResourcePoolRepository {
  create(input: ResourcePoolInput): Promise<ResourcePool>
  findById(id: string): Promise<ResourcePool | null>
  findByName(name: string): Promise<ResourcePool | null>
  findAll(): Promise<ResourcePool[]>
  addSpend(id: string, cents: number): Promise<ResourcePool | null>
  resetBudget(id: string): Promise<ResourcePool | null>
  canAcquire(id: string, runningCount: number): Promise<CanAcquireResult>
}

export function createResourcePoolRepository(ctx: RepositoryContext): ResourcePoolRepository {
  const { sql } = ctx

  return {
    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<ResourcePoolRow[]>`
        INSERT INTO resource_pools (
          id, name, max_concurrent, requests_per_minute, daily_budget_cents,
          current_spend_cents, created_at, updated_at
        ) VALUES (
          ${id},
          ${input.name},
          ${input.maxConcurrent ?? 10},
          ${input.requestsPerMinute ?? null},
          ${input.dailyBudgetCents ?? null},
          0,
          ${now},
          ${now}
        )
        RETURNING *
      `

      return rowToResourcePool(row)
    },

    async findById(id) {
      const [row] = await sql<ResourcePoolRow[]>`
        SELECT * FROM resource_pools WHERE id = ${id}
      `
      return row ? rowToResourcePool(row) : null
    },

    async findByName(name) {
      const [row] = await sql<ResourcePoolRow[]>`
        SELECT * FROM resource_pools WHERE name = ${name}
      `
      return row ? rowToResourcePool(row) : null
    },

    async findAll() {
      const rows = await sql<ResourcePoolRow[]>`
        SELECT * FROM resource_pools
        ORDER BY created_at DESC
      `
      return rows.map(rowToResourcePool)
    },

    async addSpend(id, cents) {
      const [row] = await sql<ResourcePoolRow[]>`
        UPDATE resource_pools
        SET current_spend_cents = current_spend_cents + ${cents},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToResourcePool(row) : null
    },

    async resetBudget(id) {
      const now = new Date()
      // Set reset time to next midnight
      const nextReset = new Date(now)
      nextReset.setDate(nextReset.getDate() + 1)
      nextReset.setHours(0, 0, 0, 0)

      const [row] = await sql<ResourcePoolRow[]>`
        UPDATE resource_pools
        SET current_spend_cents = 0,
            budget_reset_at = ${nextReset},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToResourcePool(row) : null
    },

    async canAcquire(id, runningCount) {
      const pool = await this.findById(id)
      if (!pool) {
        return { allowed: false, reason: `Resource pool not found: ${id}` }
      }

      // Check concurrent limit
      if (runningCount >= pool.max_concurrent) {
        return {
          allowed: false,
          reason: `Concurrent limit reached (${runningCount}/${pool.max_concurrent})`,
          retryAfter: 5000, // Suggest retry in 5 seconds
        }
      }

      // Check budget (if set)
      if (pool.daily_budget_cents !== null) {
        // Auto-reset budget if past reset time
        if (pool.budget_reset_at && new Date(pool.budget_reset_at) <= new Date()) {
          await this.resetBudget(id)
        } else if (pool.current_spend_cents >= pool.daily_budget_cents) {
          // Calculate time until budget reset
          const resetAt = pool.budget_reset_at ? new Date(pool.budget_reset_at) : null
          const retryAfter = resetAt ? Math.max(0, resetAt.getTime() - Date.now()) : undefined

          return {
            allowed: false,
            reason: `Daily budget exhausted (${pool.current_spend_cents}/${pool.daily_budget_cents} cents)`,
            retryAfter,
          }
        }
      }

      return { allowed: true }
    },
  }
}
