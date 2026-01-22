/**
 * Entity Resolution Engine
 *
 * Resolves identities to persons by finding matching candidates
 * and scoring them based on shared attributes.
 *
 * Design principles:
 * - Incremental: resolves identities as they arrive
 * - Configurable: thresholds and weights can be tuned
 * - Auditable: all decisions are recorded for review/undo
 * - Fail fast: surface errors early for debugging
 */

import type { Sql } from 'postgres'
import type { Identity, Person } from '../models/canonical.js'
import type { StoredEntity, CanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import type { MergeDecisionRepository, MergeDecisionInput } from '../db/repositories/merge-decision.js'
import type { PendingReviewRepository, PendingReviewInput } from '../db/repositories/pending-review.js'
import { createCanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import { createMergeDecisionRepository } from '../db/repositories/merge-decision.js'
import { createPendingReviewRepository } from '../db/repositories/pending-review.js'
import { generateCanonicalId, olderUlid } from '../ids.js'
import {
  type MatchScores,
  type MatchWeights,
  type MatchResult,
  type ResolutionConfig,
  type ResolutionEvent,
  MERGE_THRESHOLD,
  REVIEW_THRESHOLD,
  DEFAULT_WEIGHTS,
} from './types.js'

// ============ Fuzzy Matching Utilities ============

/**
 * Compute Levenshtein distance between two strings.
 * Used for fuzzy name matching.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Compute name similarity as a score (0-1).
 * Higher is more similar.
 */
function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0

  const normalizedA = a.toLowerCase().trim()
  const normalizedB = b.toLowerCase().trim()

  if (normalizedA === normalizedB) return 1

  const maxLen = Math.max(normalizedA.length, normalizedB.length)
  if (maxLen === 0) return 0

  const distance = levenshteinDistance(normalizedA, normalizedB)
  return Math.max(0, 1 - distance / maxLen)
}

/**
 * Normalize an email for comparison.
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

/**
 * Extract domain from email.
 */
function extractDomain(email: string): string | null {
  const parts = email.split('@')
  return parts.length === 2 ? parts[1].toLowerCase() : null
}

/**
 * Normalize a phone number by stripping non-digits.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

/**
 * Normalize username for comparison.
 */
function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ============ Entity Resolution Engine ============

export class EntityResolutionEngine {
  private sql: Sql
  private entityRepo: CanonicalEntityRepository
  private mergeRepo: MergeDecisionRepository
  private reviewRepo: PendingReviewRepository
  private config: Required<ResolutionConfig>
  private weights: MatchWeights
  private eventHandler?: (event: ResolutionEvent) => void

  constructor(sql: Sql, config: ResolutionConfig = {}) {
    this.sql = sql
    this.entityRepo = createCanonicalEntityRepository({ sql })
    this.mergeRepo = createMergeDecisionRepository({ sql })
    this.reviewRepo = createPendingReviewRepository({ sql })

    this.config = {
      mergeThreshold: config.mergeThreshold ?? MERGE_THRESHOLD,
      reviewThreshold: config.reviewThreshold ?? REVIEW_THRESHOLD,
      weights: { ...DEFAULT_WEIGHTS, ...config.weights },
      maxCandidates: config.maxCandidates ?? 100,
      enableFuzzyMatch: config.enableFuzzyMatch ?? true,
    }

    this.weights = this.config.weights as MatchWeights
  }

  /**
   * Set an event handler for resolution events.
   */
  onEvent(handler: (event: ResolutionEvent) => void): this {
    this.eventHandler = handler
    return this
  }

  /**
   * Resolve a single identity to a person.
   * Creates a new person if no match found, or links to existing.
   */
  async resolveIdentity(identityId: string): Promise<void> {
    const identityStored = await this.entityRepo.findById(identityId)
    if (!identityStored || identityStored.entity_type !== 'identity') {
      this.emit({ type: 'error', identityId, error: `Identity not found: ${identityId}` })
      return
    }

    const identity = identityStored.data as Identity

    // Already resolved?
    if (identity.person_id) {
      this.emit({ type: 'identity:resolved', identityId, personId: identity.person_id, isNew: false })
      return
    }

    // Find candidate persons
    const candidates = await this.findCandidatePersons(identity)

    if (candidates.length === 0) {
      // No candidates - create a new person
      const person = await this.createPersonFromIdentity(identity)
      await this.linkIdentityToPerson(identityId, person.id)
      this.emit({ type: 'identity:resolved', identityId, personId: person.id, isNew: true })
      return
    }

    // Score each candidate
    const matches = candidates.map((candidate) => {
      const scores = this.computeMatchScores(identity, candidate.data as Person)
      const totalScore = this.computeTotalScore(scores)
      const matchedOn = this.getMatchedFields(scores)
      return { personId: candidate.id, scores, totalScore, matchedOn }
    })

    // Find best match
    const bestMatch = matches.reduce((best, m) =>
      m.totalScore > best.totalScore ? m : best
    )

    if (bestMatch.totalScore >= this.config.mergeThreshold) {
      // Auto-merge: high confidence
      await this.linkIdentityToPerson(identityId, bestMatch.personId)
      await this.recordMergeDecision({
        primary_entity_id: bestMatch.personId,
        merged_entity_id: identityId,
        entity_type: 'identity_to_person',
        decision_type: 'auto_merge',
        confidence: bestMatch.totalScore / 100,
        reason: {
          scores: bestMatch.scores as unknown as Record<string, number>,
          totalScore: bestMatch.totalScore,
          matchedOn: bestMatch.matchedOn,
        },
        decided_by: 'system',
      })
      this.emit({
        type: 'merge:auto',
        primaryId: bestMatch.personId,
        mergedId: identityId,
        score: bestMatch.totalScore,
      })
      this.emit({
        type: 'identity:resolved',
        identityId,
        personId: bestMatch.personId,
        isNew: false,
      })
    } else if (bestMatch.totalScore >= this.config.reviewThreshold) {
      // Queue for human review
      const alreadyQueued = await this.reviewRepo.existsForPair(identityId, bestMatch.personId)
      if (!alreadyQueued) {
        await this.queueForReview({
          identity_id: identityId,
          suggested_person_id: bestMatch.personId,
          match_scores: {
            ...bestMatch.scores,
            totalScore: bestMatch.totalScore,
            matchedOn: bestMatch.matchedOn,
          },
        })
        this.emit({
          type: 'identity:queued_review',
          identityId,
          suggestedPersonId: bestMatch.personId,
          score: bestMatch.totalScore,
        })
      }
      // Identity remains unresolved until human review
    } else {
      // No good match - create a new person
      const person = await this.createPersonFromIdentity(identity)
      await this.linkIdentityToPerson(identityId, person.id)
      this.emit({ type: 'identity:resolved', identityId, personId: person.id, isNew: true })
    }
  }

  /**
   * Resolve all unresolved identities.
   */
  async resolveAllUnresolved(): Promise<{ resolved: number; queued: number; failed: number }> {
    const stats = { resolved: 0, queued: 0, failed: 0 }

    // Find identities without person_id
    const result = await this.entityRepo.findByType('identity', { limit: 1000 })
    const unresolvedIdentities = result.items.filter((e) => {
      const identity = e.data as Identity
      return !identity.person_id
    })

    for (const stored of unresolvedIdentities) {
      try {
        const identity = stored.data as Identity
        await this.resolveIdentity(stored.id)

        // Check if resolved or queued
        const updated = await this.entityRepo.findById(stored.id)
        const updatedIdentity = updated?.data as Identity
        if (updatedIdentity?.person_id) {
          stats.resolved++
        } else {
          const pending = await this.reviewRepo.findByIdentity(stored.id)
          if (pending.length > 0) {
            stats.queued++
          }
        }
      } catch (error) {
        stats.failed++
        this.emit({
          type: 'error',
          identityId: stored.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return stats
  }

  /**
   * Apply a human review decision.
   */
  async applyReviewDecision(
    reviewId: string,
    decision: 'approve' | 'reject',
    reviewedBy?: string
  ): Promise<boolean> {
    const review = await this.reviewRepo.findById(reviewId)
    if (!review || review.reviewed_at) {
      return false
    }

    if (decision === 'approve') {
      await this.reviewRepo.approve(reviewId)
      await this.linkIdentityToPerson(review.identity_id, review.suggested_person_id)
      await this.recordMergeDecision({
        primary_entity_id: review.suggested_person_id,
        merged_entity_id: review.identity_id,
        entity_type: 'identity_to_person',
        decision_type: 'human_merge',
        confidence: review.match_scores.totalScore / 100,
        reason: {
          scores: review.match_scores as unknown as Record<string, number>,
          totalScore: review.match_scores.totalScore,
          matchedOn: review.match_scores.matchedOn,
        },
        decided_by: reviewedBy,
      })
      this.emit({
        type: 'merge:human',
        primaryId: review.suggested_person_id,
        mergedId: review.identity_id,
      })
      this.emit({
        type: 'identity:resolved',
        identityId: review.identity_id,
        personId: review.suggested_person_id,
        isNew: false,
      })
    } else {
      await this.reviewRepo.reject(reviewId)
      await this.recordMergeDecision({
        primary_entity_id: review.suggested_person_id,
        merged_entity_id: review.identity_id,
        entity_type: 'identity_to_person',
        decision_type: 'human_reject',
        confidence: review.match_scores.totalScore / 100,
        decided_by: reviewedBy,
      })
      this.emit({
        type: 'merge:rejected',
        identityId: review.identity_id,
        suggestedPersonId: review.suggested_person_id,
      })
    }

    return true
  }

  /**
   * Merge two persons into one.
   * The older person (by ID) becomes the primary.
   */
  async mergePersons(
    personAId: string,
    personBId: string,
    mergedBy?: string
  ): Promise<string | null> {
    const [personA, personB] = await Promise.all([
      this.entityRepo.findById(personAId),
      this.entityRepo.findById(personBId),
    ])

    if (!personA || !personB) return null
    if (personA.entity_type !== 'person' || personB.entity_type !== 'person') return null

    // Older person becomes primary (stable ordering)
    const primaryId = olderUlid(personAId, personBId)
    const mergedId = primaryId === personAId ? personBId : personAId
    const primary = (primaryId === personAId ? personA : personB).data as Person
    const merged = (primaryId === personAId ? personB : personA).data as Person

    // Merge data: combine arrays, prefer primary's scalar values
    const mergedData: Partial<Person> = {
      display_name: primary.display_name || merged.display_name,
      avatar_url: primary.avatar_url || merged.avatar_url,
      emails: [...new Set([...primary.emails, ...merged.emails])],
      phones: [...new Set([...primary.phones, ...merged.phones])],
      usernames: this.mergeUsernames(primary.usernames, merged.usernames),
      org_ids: [...new Set([...primary.org_ids, ...merged.org_ids])],
      identity_ids: [...new Set([...primary.identity_ids, ...merged.identity_ids])],
    }

    // Update primary person
    await this.entityRepo.update(primaryId, mergedData)

    // Re-link all identities from merged person to primary
    for (const identityId of merged.identity_ids) {
      await this.linkIdentityToPerson(identityId, primaryId)
    }

    // Soft delete merged person
    await this.entityRepo.softDelete(mergedId)

    // Record the merge decision
    await this.recordMergeDecision({
      primary_entity_id: primaryId,
      merged_entity_id: mergedId,
      entity_type: 'person',
      decision_type: 'human_merge',
      confidence: 1.0,
      decided_by: mergedBy,
    })

    return primaryId
  }

  // ============ Private Methods ============

  private async findCandidatePersons(identity: Identity): Promise<StoredEntity[]> {
    // Strategy: Find persons with overlapping attributes
    // For performance, we use multiple targeted queries instead of scanning all persons

    const candidateIds = new Set<string>()

    // 1. Find by exact email match
    if (identity.email) {
      const normalizedEmail = normalizeEmail(identity.email)
      const rows = await this.sql<{ id: string }[]>`
        SELECT id FROM canonical_entities
        WHERE entity_type = 'person'
          AND deleted_at IS NULL
          AND data->'emails' ? ${normalizedEmail}
        LIMIT ${this.config.maxCandidates}
      `
      rows.forEach((r) => candidateIds.add(r.id))
    }

    // 2. Find by username match on same platform
    if (identity.username && identity.platform) {
      const normalizedUsername = normalizeUsername(identity.username)
      const rows = await this.sql<{ id: string }[]>`
        SELECT id FROM canonical_entities
        WHERE entity_type = 'person'
          AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(data->'usernames') u
            WHERE LOWER(u->>'platform') = ${identity.platform}
              AND LOWER(REGEXP_REPLACE(u->>'username', '[^a-z0-9]', '', 'gi')) = ${normalizedUsername}
          )
        LIMIT ${this.config.maxCandidates}
      `
      rows.forEach((r) => candidateIds.add(r.id))
    }

    // 3. Find by display name (fuzzy)
    if (identity.display_name && this.config.enableFuzzyMatch) {
      const normalizedName = identity.display_name.toLowerCase().trim()
      const rows = await this.sql<{ id: string }[]>`
        SELECT id FROM canonical_entities
        WHERE entity_type = 'person'
          AND deleted_at IS NULL
          AND LOWER(data->>'display_name') % ${normalizedName}
        LIMIT ${this.config.maxCandidates}
      `
      rows.forEach((r) => candidateIds.add(r.id))
    }

    if (candidateIds.size === 0) {
      return []
    }

    // Fetch full entities for scoring
    return this.entityRepo.findByIds(Array.from(candidateIds).slice(0, this.config.maxCandidates))
  }

  private computeMatchScores(identity: Identity, person: Person): MatchScores {
    const scores: MatchScores = {
      emailExact: 0,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 0,
      nameExact: 0,
      nameFuzzy: 0,
      orgOverlap: 0,
    }

    // Email exact match
    if (identity.email && person.emails.length > 0) {
      const normalizedIdentityEmail = normalizeEmail(identity.email)
      const normalizedPersonEmails = person.emails.map(normalizeEmail)

      if (normalizedPersonEmails.includes(normalizedIdentityEmail)) {
        scores.emailExact = 100
      } else {
        // Check domain match
        const identityDomain = extractDomain(identity.email)
        if (identityDomain) {
          const personDomains = normalizedPersonEmails
            .map(extractDomain)
            .filter((d): d is string => d !== null)

          if (personDomains.includes(identityDomain)) {
            // Don't score generic domains highly
            const genericDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']
            scores.emailDomain = genericDomains.includes(identityDomain) ? 5 : 30
          }
        }
      }
    }

    // Phone exact match (not commonly available for identities)
    // Placeholder for future implementation

    // Username match
    if (identity.username && identity.platform) {
      const normalizedIdentityUsername = normalizeUsername(identity.username)
      for (const u of person.usernames) {
        if (
          u.platform === identity.platform &&
          normalizeUsername(u.username) === normalizedIdentityUsername
        ) {
          scores.usernameMatch = 50
          break
        }
      }

      // Cross-platform username similarity
      if (scores.usernameMatch === 0) {
        for (const u of person.usernames) {
          const normalizedPersonUsername = normalizeUsername(u.username)
          const similarity = nameSimilarity(normalizedIdentityUsername, normalizedPersonUsername)
          if (similarity > 0.9) {
            scores.usernameMatch = Math.max(scores.usernameMatch, 30)
          } else if (similarity > 0.7) {
            scores.usernameMatch = Math.max(scores.usernameMatch, 15)
          }
        }
      }
    }

    // Name matching
    if (identity.display_name && person.display_name) {
      const normalizedIdentityName = identity.display_name.toLowerCase().trim()
      const normalizedPersonName = person.display_name.toLowerCase().trim()

      if (normalizedIdentityName === normalizedPersonName) {
        scores.nameExact = 40
      } else if (this.config.enableFuzzyMatch) {
        const similarity = nameSimilarity(normalizedIdentityName, normalizedPersonName)
        scores.nameFuzzy = Math.round(similarity * 30)
      }
    }

    // Org overlap (if implemented)
    // Placeholder - would compare org_ids

    return scores
  }

  private computeTotalScore(scores: MatchScores): number {
    // Calculate weighted sum, then normalize
    let weightedSum = 0
    let maxPossible = 0

    const scoreEntries: [keyof MatchScores, number][] = [
      ['emailExact', 100],
      ['emailDomain', 30],
      ['phoneExact', 100],
      ['usernameMatch', 50],
      ['nameExact', 40],
      ['nameFuzzy', 30],
      ['orgOverlap', 20],
    ]

    for (const [key, maxScore] of scoreEntries) {
      const weight = this.weights[key]
      weightedSum += scores[key] * weight
      maxPossible += maxScore * weight
    }

    // Normalize to 0-100 scale
    return maxPossible > 0 ? Math.round((weightedSum / maxPossible) * 100) : 0
  }

  private getMatchedFields(scores: MatchScores): string[] {
    const matched: string[] = []
    if (scores.emailExact > 0) matched.push('email_exact')
    if (scores.emailDomain > 0) matched.push('email_domain')
    if (scores.phoneExact > 0) matched.push('phone')
    if (scores.usernameMatch > 0) matched.push('username')
    if (scores.nameExact > 0) matched.push('name_exact')
    if (scores.nameFuzzy > 0) matched.push('name_fuzzy')
    if (scores.orgOverlap > 0) matched.push('org')
    return matched
  }

  private async createPersonFromIdentity(identity: Identity): Promise<StoredEntity> {
    const now = new Date().toISOString()
    const personId = generateCanonicalId()

    const person: Person = {
      id: personId,
      entity_type: 'person',
      created_at: now,
      updated_at: now,
      source_refs: identity.source_refs, // Inherit source refs
      display_name: identity.display_name,
      avatar_url: identity.avatar_url,
      emails: identity.email ? [identity.email] : [],
      phones: [],
      usernames: identity.username
        ? [{ platform: identity.platform, username: identity.username }]
        : [],
      org_ids: [],
      identity_ids: [identity.id],
    }

    return this.entityRepo.create('person', person, person.display_name)
  }

  private async linkIdentityToPerson(identityId: string, personId: string): Promise<void> {
    // Update identity's person_id
    await this.entityRepo.update(identityId, { person_id: personId })

    // Add identity to person's identity_ids
    const person = await this.entityRepo.findById(personId)
    if (person) {
      const personData = person.data as Person
      const identity = await this.entityRepo.findById(identityId)
      if (identity) {
        const identityData = identity.data as Identity

        // Merge identity's info into person
        const updatedIdentityIds = [...new Set([...personData.identity_ids, identityId])]
        const updatedEmails = identityData.email
          ? [...new Set([...personData.emails, identityData.email])]
          : personData.emails
        const updatedUsernames = identityData.username
          ? this.mergeUsernames(personData.usernames, [
              { platform: identityData.platform, username: identityData.username },
            ])
          : personData.usernames

        await this.entityRepo.update(personId, {
          identity_ids: updatedIdentityIds,
          emails: updatedEmails,
          usernames: updatedUsernames,
          display_name: personData.display_name || identityData.display_name,
          avatar_url: personData.avatar_url || identityData.avatar_url,
        })
      }
    }
  }

  private mergeUsernames(
    a: Array<{ platform: string; username: string }>,
    b: Array<{ platform: string; username: string }>
  ): Array<{ platform: string; username: string }> {
    const seen = new Set<string>()
    const result: Array<{ platform: string; username: string }> = []

    for (const u of [...a, ...b]) {
      const key = `${u.platform}:${u.username.toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push(u)
      }
    }

    return result
  }

  private async recordMergeDecision(input: MergeDecisionInput): Promise<void> {
    await this.mergeRepo.create(input)
  }

  private async queueForReview(input: PendingReviewInput): Promise<void> {
    await this.reviewRepo.create(input)
  }

  private emit(event: ResolutionEvent): void {
    if (this.eventHandler) {
      try {
        this.eventHandler(event)
      } catch {
        // Ignore event handler errors
      }
    }
  }
}
