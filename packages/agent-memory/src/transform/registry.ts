import type { ConnectorType } from '../ids.js'
import type { Transformation } from './types.js'

/**
 * Registry for transformation definitions.
 */
export class TransformationRegistry {
  private transformations: Map<string, Transformation> = new Map()

  /**
   * Register a transformation.
   */
  register<TInput>(transformation: Transformation<TInput>): this {
    if (this.transformations.has(transformation.id)) {
      throw new Error(`Transformation already registered: ${transformation.id}`)
    }
    this.transformations.set(transformation.id, transformation as Transformation)
    return this
  }

  /**
   * Unregister a transformation.
   */
  unregister(id: string): boolean {
    return this.transformations.delete(id)
  }

  /**
   * Get a transformation by ID.
   */
  get(id: string): Transformation | undefined {
    return this.transformations.get(id)
  }

  /**
   * Find all transformations matching a source.
   */
  findBySource(connector: ConnectorType, entityType: string): Transformation[] {
    const matches: Transformation[] = []

    for (const t of this.transformations.values()) {
      if (!t.enabled) continue
      if (t.source.connector !== connector) continue
      if (t.source.entityType !== entityType) continue
      matches.push(t)
    }

    return matches
  }

  /**
   * Find all transformations for a connector.
   */
  findByConnector(connector: ConnectorType): Transformation[] {
    const matches: Transformation[] = []

    for (const t of this.transformations.values()) {
      if (t.source.connector === connector) {
        matches.push(t)
      }
    }

    return matches
  }

  /**
   * List all registered transformations.
   */
  list(): Transformation[] {
    return Array.from(this.transformations.values())
  }

  /**
   * Check if any transformation exists for a source.
   */
  hasTransformation(connector: ConnectorType, entityType: string): boolean {
    return this.findBySource(connector, entityType).length > 0
  }

  /**
   * Enable/disable a transformation.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const t = this.transformations.get(id)
    if (!t) return false
    t.enabled = enabled
    return true
  }
}
