/**
 * Research Repository
 *
 * CRUD for the deep-research pipeline: projects, nodes, sources, claims.
 * Tree-structured research with staleness tracking.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

// ============ Row Types (snake_case, match DB columns) ============

export interface ResearchProjectRow {
  id: string
  title: string
  seed_query: string
  status: string
  depth_budget: number
  max_sources_per_node: number
  output_path: string | null
  created_at: Date
  updated_at: Date
}

export interface ResearchNodeRow {
  id: string
  project_id: string
  parent_id: string | null
  depth: number
  query: string
  query_type: string | null
  status: string
  synthesis: string | null
  significance: string | null
  first_principles: unknown | null
  gaps: unknown | null
  priority_score: number | null
  novelty_score: number | null
  gap_density: number | null
  created_at: Date
  updated_at: Date
}

export interface ResearchSourceRow {
  id: string
  node_id: string
  url: string
  title: string | null
  domain: string | null
  raw_content: string | null
  extracted_content: string | null
  quality_score: number | null
  fetch_date: Date
  created_at: Date
}

export interface ResearchClaimRow {
  id: string
  node_id: string
  source_id: string | null
  claim_text: string
  evidence_text: string | null
  confidence: string
  volatility: string
  first_seen_at: Date
  last_verified_at: Date
  status: string
  superseded_by: string | null
  created_at: Date
}

// ============ Domain Types (camelCase) ============

export type ResearchProjectStatus = 'active' | 'paused' | 'complete'
export type ResearchNodeStatus = 'pending' | 'collecting' | 'reducing' | 'synthesizing' | 'scored' | 'terminal'
export type QueryType = 'definitional' | 'mechanistic' | 'comparative' | 'causal' | 'critical'
export type ClaimConfidence = 'high' | 'medium' | 'low'
export type ClaimVolatility = 'stable' | 'moderate' | 'volatile'
export type ClaimStatus = 'active' | 'superseded' | 'contradicted' | 'retracted'

export interface FirstPrinciple {
  text: string
  category: 'empirical' | 'definitional' | 'assumption'
  dependsOn: string[]
}

export interface Gap {
  question: string
  importance: number
}

export interface ResearchProject {
  id: string
  title: string
  seedQuery: string
  status: ResearchProjectStatus
  depthBudget: number
  maxSourcesPerNode: number
  outputPath: string | null
  createdAt: string
  updatedAt: string
}

export interface ResearchNode {
  id: string
  projectId: string
  parentId: string | null
  depth: number
  query: string
  queryType: QueryType | null
  status: ResearchNodeStatus
  synthesis: string | null
  significance: string | null
  firstPrinciples: FirstPrinciple[] | null
  gaps: Gap[] | null
  priorityScore: number | null
  noveltyScore: number | null
  gapDensity: number | null
  createdAt: string
  updatedAt: string
}

export interface ResearchSource {
  id: string
  nodeId: string
  url: string
  title: string | null
  domain: string | null
  rawContent: string | null
  extractedContent: string | null
  qualityScore: number | null
  fetchDate: string
  createdAt: string
}

export interface ResearchClaim {
  id: string
  nodeId: string
  sourceId: string | null
  claimText: string
  evidenceText: string | null
  confidence: ClaimConfidence
  volatility: ClaimVolatility
  firstSeenAt: string
  lastVerifiedAt: string
  status: ClaimStatus
  supersededBy: string | null
  createdAt: string
}

// ============ Input Types ============

export interface CreateProjectInput {
  title: string
  seedQuery: string
  depthBudget?: number
  maxSourcesPerNode?: number
  outputPath?: string
}

export interface CreateNodeInput {
  projectId: string
  parentId?: string
  depth: number
  query: string
  queryType?: QueryType
}

export interface CreateSourceInput {
  nodeId: string
  url: string
  title?: string
  domain?: string
  rawContent?: string
  extractedContent?: string
  qualityScore?: number
}

export interface CreateClaimInput {
  nodeId: string
  sourceId?: string
  claimText: string
  evidenceText?: string
  confidence?: ClaimConfidence
  volatility?: ClaimVolatility
}

export interface NodeSynthesisInput {
  synthesis: string
  significance: string
  firstPrinciples: FirstPrinciple[]
  gaps: Gap[]
}

export interface NodeScoresInput {
  priorityScore: number
  noveltyScore: number
  gapDensity: number
}

// ============ Mappers ============

function rowToProject(row: ResearchProjectRow): ResearchProject {
  return {
    id: row.id,
    title: row.title,
    seedQuery: row.seed_query,
    status: row.status as ResearchProjectStatus,
    depthBudget: row.depth_budget,
    maxSourcesPerNode: row.max_sources_per_node,
    outputPath: row.output_path,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function rowToNode(row: ResearchNodeRow): ResearchNode {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    depth: row.depth,
    query: row.query,
    queryType: row.query_type as QueryType | null,
    status: row.status as ResearchNodeStatus,
    synthesis: row.synthesis,
    significance: row.significance,
    firstPrinciples: (row.first_principles as FirstPrinciple[]) ?? null,
    gaps: (row.gaps as Gap[]) ?? null,
    priorityScore: row.priority_score,
    noveltyScore: row.novelty_score,
    gapDensity: row.gap_density,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function rowToSource(row: ResearchSourceRow): ResearchSource {
  return {
    id: row.id,
    nodeId: row.node_id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    rawContent: row.raw_content,
    extractedContent: row.extracted_content,
    qualityScore: row.quality_score,
    fetchDate: row.fetch_date.toISOString(),
    createdAt: row.created_at.toISOString(),
  }
}

function rowToClaim(row: ResearchClaimRow): ResearchClaim {
  return {
    id: row.id,
    nodeId: row.node_id,
    sourceId: row.source_id,
    claimText: row.claim_text,
    evidenceText: row.evidence_text,
    confidence: row.confidence as ClaimConfidence,
    volatility: row.volatility as ClaimVolatility,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastVerifiedAt: row.last_verified_at.toISOString(),
    status: row.status as ClaimStatus,
    supersededBy: row.superseded_by,
    createdAt: row.created_at.toISOString(),
  }
}

// ============ Repository Interface ============

export interface ResearchRepository {
  // Projects
  createProject(input: CreateProjectInput): Promise<ResearchProject>
  findProjectById(id: string): Promise<ResearchProject | null>
  findProjects(filters?: { status?: ResearchProjectStatus }, limit?: number): Promise<ResearchProject[]>
  updateProjectStatus(id: string, status: ResearchProjectStatus): Promise<ResearchProject | null>
  updateProjectOutputPath(id: string, outputPath: string): Promise<ResearchProject | null>
  deleteProject(id: string): Promise<boolean>

  // Nodes
  createNode(input: CreateNodeInput): Promise<ResearchNode>
  findNodeById(id: string): Promise<ResearchNode | null>
  findNodesByProject(projectId: string, filters?: { status?: ResearchNodeStatus; depth?: number }): Promise<ResearchNode[]>
  findChildNodes(parentId: string): Promise<ResearchNode[]>
  findTopScoredNodes(projectId: string, limit?: number): Promise<ResearchNode[]>
  updateNodeStatus(id: string, status: ResearchNodeStatus): Promise<ResearchNode | null>
  updateNodeSynthesis(id: string, input: NodeSynthesisInput): Promise<ResearchNode | null>
  updateNodeScores(id: string, input: NodeScoresInput): Promise<ResearchNode | null>

  // Sources
  createSource(input: CreateSourceInput): Promise<ResearchSource>
  findSourcesByNode(nodeId: string): Promise<ResearchSource[]>
  findDomainsByNode(nodeId: string): Promise<string[]>
  countSourcesByNode(nodeId: string): Promise<number>

  // Claims
  createClaim(input: CreateClaimInput): Promise<ResearchClaim>
  findClaimsByNode(nodeId: string): Promise<ResearchClaim[]>
  findStaleClaims(limit?: number): Promise<ResearchClaim[]>
  updateClaimVerified(id: string): Promise<ResearchClaim | null>
  updateClaimStatus(id: string, status: ClaimStatus, supersededBy?: string): Promise<ResearchClaim | null>

  // Tree helpers
  findFullTree(projectId: string): Promise<ResearchNode[]>
}

// ============ Factory ============

export function createResearchRepository(ctx: RepositoryContext): ResearchRepository {
  const { sql } = ctx

  return {
    // ---- Projects ----

    async createProject(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<ResearchProjectRow[]>`
        INSERT INTO research_projects (
          id, title, seed_query, status,
          depth_budget, max_sources_per_node, output_path,
          created_at, updated_at
        ) VALUES (
          ${id},
          ${input.title},
          ${input.seedQuery},
          'active',
          ${input.depthBudget ?? 3},
          ${input.maxSourcesPerNode ?? 8},
          ${input.outputPath ?? null},
          ${now},
          ${now}
        )
        RETURNING *
      `
      return rowToProject(row)
    },

    async findProjectById(id) {
      const [row] = await sql<ResearchProjectRow[]>`
        SELECT * FROM research_projects WHERE id = ${id}
      `
      return row ? rowToProject(row) : null
    },

    async findProjects(filters, limit = 50) {
      if (filters?.status) {
        const rows = await sql<ResearchProjectRow[]>`
          SELECT * FROM research_projects
          WHERE status = ${filters.status}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `
        return rows.map(rowToProject)
      }
      const rows = await sql<ResearchProjectRow[]>`
        SELECT * FROM research_projects
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToProject)
    },

    async updateProjectStatus(id, status) {
      const [row] = await sql<ResearchProjectRow[]>`
        UPDATE research_projects SET status = ${status} WHERE id = ${id} RETURNING *
      `
      return row ? rowToProject(row) : null
    },

    async updateProjectOutputPath(id, outputPath) {
      const [row] = await sql<ResearchProjectRow[]>`
        UPDATE research_projects SET output_path = ${outputPath} WHERE id = ${id} RETURNING *
      `
      return row ? rowToProject(row) : null
    },

    async deleteProject(id) {
      const result = await sql`DELETE FROM research_projects WHERE id = ${id}`
      return result.count > 0
    },

    // ---- Nodes ----

    async createNode(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<ResearchNodeRow[]>`
        INSERT INTO research_nodes (
          id, project_id, parent_id, depth,
          query, query_type, status,
          created_at, updated_at
        ) VALUES (
          ${id},
          ${input.projectId},
          ${input.parentId ?? null},
          ${input.depth},
          ${input.query},
          ${input.queryType ?? null},
          'pending',
          ${now},
          ${now}
        )
        RETURNING *
      `
      return rowToNode(row)
    },

    async findNodeById(id) {
      const [row] = await sql<ResearchNodeRow[]>`
        SELECT * FROM research_nodes WHERE id = ${id}
      `
      return row ? rowToNode(row) : null
    },

    async findNodesByProject(projectId, filters) {
      if (filters?.status && filters?.depth !== undefined) {
        const rows = await sql<ResearchNodeRow[]>`
          SELECT * FROM research_nodes
          WHERE project_id = ${projectId}
            AND status = ${filters.status}
            AND depth = ${filters.depth}
          ORDER BY priority_score DESC NULLS LAST, created_at ASC
        `
        return rows.map(rowToNode)
      }
      if (filters?.status) {
        const rows = await sql<ResearchNodeRow[]>`
          SELECT * FROM research_nodes
          WHERE project_id = ${projectId} AND status = ${filters.status}
          ORDER BY priority_score DESC NULLS LAST, created_at ASC
        `
        return rows.map(rowToNode)
      }
      if (filters?.depth !== undefined) {
        const rows = await sql<ResearchNodeRow[]>`
          SELECT * FROM research_nodes
          WHERE project_id = ${projectId} AND depth = ${filters.depth}
          ORDER BY created_at ASC
        `
        return rows.map(rowToNode)
      }
      const rows = await sql<ResearchNodeRow[]>`
        SELECT * FROM research_nodes
        WHERE project_id = ${projectId}
        ORDER BY depth ASC, created_at ASC
      `
      return rows.map(rowToNode)
    },

    async findChildNodes(parentId) {
      const rows = await sql<ResearchNodeRow[]>`
        SELECT * FROM research_nodes
        WHERE parent_id = ${parentId}
        ORDER BY created_at ASC
      `
      return rows.map(rowToNode)
    },

    async findTopScoredNodes(projectId, limit = 5) {
      const rows = await sql<ResearchNodeRow[]>`
        SELECT * FROM research_nodes
        WHERE project_id = ${projectId} AND status = 'scored'
        ORDER BY priority_score DESC NULLS LAST
        LIMIT ${limit}
      `
      return rows.map(rowToNode)
    },

    async updateNodeStatus(id, status) {
      const [row] = await sql<ResearchNodeRow[]>`
        UPDATE research_nodes SET status = ${status} WHERE id = ${id} RETURNING *
      `
      return row ? rowToNode(row) : null
    },

    async updateNodeSynthesis(id, input) {
      const [row] = await sql<ResearchNodeRow[]>`
        UPDATE research_nodes
        SET synthesis = ${input.synthesis},
            significance = ${input.significance},
            first_principles = ${sql.json(input.firstPrinciples as any)},
            gaps = ${sql.json(input.gaps as any)}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToNode(row) : null
    },

    async updateNodeScores(id, input) {
      const [row] = await sql<ResearchNodeRow[]>`
        UPDATE research_nodes
        SET priority_score = ${input.priorityScore},
            novelty_score = ${input.noveltyScore},
            gap_density = ${input.gapDensity},
            status = 'scored'
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToNode(row) : null
    },

    // ---- Sources ----

    async createSource(input) {
      const id = generateCanonicalId()

      const [row] = await sql<ResearchSourceRow[]>`
        INSERT INTO research_sources (
          id, node_id, url, title, domain,
          raw_content, extracted_content, quality_score,
          fetch_date, created_at
        ) VALUES (
          ${id},
          ${input.nodeId},
          ${input.url},
          ${input.title ?? null},
          ${input.domain ?? null},
          ${input.rawContent ?? null},
          ${input.extractedContent ?? null},
          ${input.qualityScore ?? null},
          NOW(),
          NOW()
        )
        RETURNING *
      `
      return rowToSource(row)
    },

    async findSourcesByNode(nodeId) {
      const rows = await sql<ResearchSourceRow[]>`
        SELECT * FROM research_sources
        WHERE node_id = ${nodeId}
        ORDER BY quality_score DESC NULLS LAST, created_at ASC
      `
      return rows.map(rowToSource)
    },

    async findDomainsByNode(nodeId) {
      const rows = await sql<{ domain: string }[]>`
        SELECT DISTINCT domain FROM research_sources
        WHERE node_id = ${nodeId} AND domain IS NOT NULL
      `
      return rows.map(r => r.domain)
    },

    async countSourcesByNode(nodeId) {
      const [result] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM research_sources WHERE node_id = ${nodeId}
      `
      return parseInt(result?.count ?? '0', 10)
    },

    // ---- Claims ----

    async createClaim(input) {
      const id = generateCanonicalId()

      const [row] = await sql<ResearchClaimRow[]>`
        INSERT INTO research_claims (
          id, node_id, source_id,
          claim_text, evidence_text,
          confidence, volatility,
          first_seen_at, last_verified_at,
          status, created_at
        ) VALUES (
          ${id},
          ${input.nodeId},
          ${input.sourceId ?? null},
          ${input.claimText},
          ${input.evidenceText ?? null},
          ${input.confidence ?? 'medium'},
          ${input.volatility ?? 'moderate'},
          NOW(), NOW(),
          'active',
          NOW()
        )
        RETURNING *
      `
      return rowToClaim(row)
    },

    async findClaimsByNode(nodeId) {
      const rows = await sql<ResearchClaimRow[]>`
        SELECT * FROM research_claims
        WHERE node_id = ${nodeId}
        ORDER BY confidence DESC, created_at ASC
      `
      return rows.map(rowToClaim)
    },

    async findStaleClaims(limit = 20) {
      const rows = await sql<ResearchClaimRow[]>`
        SELECT * FROM research_claims
        WHERE status = 'active'
          AND (
            (volatility = 'volatile' AND last_verified_at < NOW() - INTERVAL '6 months')
            OR (volatility = 'moderate' AND last_verified_at < NOW() - INTERVAL '2 years')
          )
        ORDER BY last_verified_at ASC
        LIMIT ${limit}
      `
      return rows.map(rowToClaim)
    },

    async updateClaimVerified(id) {
      const [row] = await sql<ResearchClaimRow[]>`
        UPDATE research_claims
        SET last_verified_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToClaim(row) : null
    },

    async updateClaimStatus(id, status, supersededBy) {
      const [row] = await sql<ResearchClaimRow[]>`
        UPDATE research_claims
        SET status = ${status},
            superseded_by = ${supersededBy ?? null}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToClaim(row) : null
    },

    // ---- Tree helpers ----

    async findFullTree(projectId) {
      const rows = await sql<ResearchNodeRow[]>`
        SELECT * FROM research_nodes
        WHERE project_id = ${projectId}
        ORDER BY depth ASC, created_at ASC
      `
      return rows.map(rowToNode)
    },
  }
}
