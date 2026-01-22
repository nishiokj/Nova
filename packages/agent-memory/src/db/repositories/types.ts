/**
 * Repository Types
 *
 * Common types and interfaces for database repositories.
 */

import type { Sql } from 'postgres'

export interface Repository<T, TInput, TId = string> {
  /** Find entity by ID */
  findById(id: TId): Promise<T | null>
  /** Find all entities matching criteria */
  findMany(criteria?: Partial<T>): Promise<T[]>
  /** Create a new entity */
  create(input: TInput): Promise<T>
  /** Update an existing entity */
  update(id: TId, updates: Partial<T>): Promise<T | null>
  /** Delete an entity by ID */
  delete(id: TId): Promise<boolean>
}

export interface PaginationOptions {
  limit?: number
  offset?: number
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  hasMore: boolean
}

/** Base context passed to all repositories */
export interface RepositoryContext {
  sql: Sql
}

/** Create repository context from a Sql instance */
export function createRepositoryContext(sql: Sql): RepositoryContext {
  return { sql }
}
