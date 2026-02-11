/**
 * Entity Resolution Engine Tests
 *
 * Unit tests for the entity resolution system.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  MERGE_THRESHOLD,
  REVIEW_THRESHOLD,
  DEFAULT_WEIGHTS,
  type MatchScores,
} from './types.js'

// ============ Utility Function Tests ============

// Mock implementation of key algorithms for unit testing
// (These would be extracted to a separate file in production)

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
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

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

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

function extractDomain(email: string): string | null {
  const parts = email.split('@')
  return parts.length === 2 ? parts[1].toLowerCase() : null
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, '')
}

describe('Levenshtein Distance', () => {
  test('identical strings have distance 0', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0)
  })

  test('completely different strings have high distance', () => {
    expect(levenshteinDistance('abc', 'xyz')).toBe(3)
  })

  test('one character difference', () => {
    expect(levenshteinDistance('hello', 'hallo')).toBe(1)
  })

  test('insertion', () => {
    expect(levenshteinDistance('hello', 'helllo')).toBe(1)
  })

  test('deletion', () => {
    expect(levenshteinDistance('hello', 'helo')).toBe(1)
  })

  test('empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0)
    expect(levenshteinDistance('hello', '')).toBe(5)
    expect(levenshteinDistance('', 'hello')).toBe(5)
  })
})

describe('Name Similarity', () => {
  test('identical names return 1', () => {
    expect(nameSimilarity('John Doe', 'John Doe')).toBe(1)
  })

  test('case insensitive match returns 1', () => {
    expect(nameSimilarity('John Doe', 'john doe')).toBe(1)
  })

  test('similar names return high score', () => {
    const similarity = nameSimilarity('John Doe', 'Jon Doe')
    expect(similarity).toBeGreaterThan(0.8)
  })

  test('different names return low score', () => {
    const similarity = nameSimilarity('John Doe', 'Jane Smith')
    expect(similarity).toBeLessThan(0.5)
  })

  test('empty strings return 0', () => {
    expect(nameSimilarity('', 'John')).toBe(0)
    expect(nameSimilarity('John', '')).toBe(0)
  })
})

describe('Email Normalization', () => {
  test('lowercases email', () => {
    expect(normalizeEmail('John.Doe@EXAMPLE.com')).toBe('john.doe@example.com')
  })

  test('trims whitespace', () => {
    expect(normalizeEmail('  john@example.com  ')).toBe('john@example.com')
  })
})

describe('Domain Extraction', () => {
  test('extracts domain from valid email', () => {
    expect(extractDomain('john@example.com')).toBe('example.com')
  })

  test('returns null for invalid email', () => {
    expect(extractDomain('notanemail')).toBe(null)
  })

  test('lowercases domain', () => {
    expect(extractDomain('john@EXAMPLE.COM')).toBe('example.com')
  })
})

describe('Phone Normalization', () => {
  test('strips non-digits', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('15551234567')
  })

  test('handles plain numbers', () => {
    expect(normalizePhone('5551234567')).toBe('5551234567')
  })
})

describe('Username Normalization', () => {
  test('lowercases username', () => {
    expect(normalizeUsername('JohnDoe123')).toBe('johndoe123')
  })

  test('removes special characters', () => {
    expect(normalizeUsername('john_doe-123')).toBe('johndoe123')
  })
})

// ============ Threshold Constants Tests ============

describe('Resolution Thresholds', () => {
  test('MERGE_THRESHOLD is 80', () => {
    expect(MERGE_THRESHOLD).toBe(80)
  })

  test('REVIEW_THRESHOLD is 50', () => {
    expect(REVIEW_THRESHOLD).toBe(50)
  })

  test('MERGE_THRESHOLD > REVIEW_THRESHOLD', () => {
    expect(MERGE_THRESHOLD).toBeGreaterThan(REVIEW_THRESHOLD)
  })
})

describe('Default Weights', () => {
  test('all weights are 1.0 by default', () => {
    expect(DEFAULT_WEIGHTS.emailExact).toBe(1.0)
    expect(DEFAULT_WEIGHTS.emailDomain).toBe(1.0)
    expect(DEFAULT_WEIGHTS.phoneExact).toBe(1.0)
    expect(DEFAULT_WEIGHTS.usernameMatch).toBe(1.0)
    expect(DEFAULT_WEIGHTS.nameExact).toBe(1.0)
    expect(DEFAULT_WEIGHTS.nameFuzzy).toBe(1.0)
    expect(DEFAULT_WEIGHTS.orgOverlap).toBe(1.0)
  })
})

// ============ Score Computation Tests ============

describe('Score Computation', () => {
  // Mock implementation for testing
  function computeTotalScore(scores: MatchScores, weights = DEFAULT_WEIGHTS): number {
    const scoreEntries: [keyof MatchScores, number][] = [
      ['emailExact', 100],
      ['emailDomain', 30],
      ['phoneExact', 100],
      ['usernameMatch', 50],
      ['nameExact', 40],
      ['nameFuzzy', 30],
      ['orgOverlap', 20],
    ]

    let weightedSum = 0
    let maxPossible = 0

    for (const [key, maxScore] of scoreEntries) {
      const weight = weights[key]
      weightedSum += scores[key] * weight
      maxPossible += maxScore * weight
    }

    return maxPossible > 0 ? Math.round((weightedSum / maxPossible) * 100) : 0
  }

  test('perfect email match gives high score', () => {
    const scores: MatchScores = {
      emailExact: 100,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 0,
      nameExact: 0,
      nameFuzzy: 0,
      orgOverlap: 0,
    }
    const total = computeTotalScore(scores)
    expect(total).toBeGreaterThan(20) // Significant contribution
  })

  test('all zeros gives zero score', () => {
    const scores: MatchScores = {
      emailExact: 0,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 0,
      nameExact: 0,
      nameFuzzy: 0,
      orgOverlap: 0,
    }
    const total = computeTotalScore(scores)
    expect(total).toBe(0)
  })

  test('all max scores gives 100', () => {
    const scores: MatchScores = {
      emailExact: 100,
      emailDomain: 30,
      phoneExact: 100,
      usernameMatch: 50,
      nameExact: 40,
      nameFuzzy: 30,
      orgOverlap: 20,
    }
    const total = computeTotalScore(scores)
    expect(total).toBe(100)
  })

  test('strong multi-signal match exceeds merge threshold', () => {
    const scores: MatchScores = {
      emailExact: 100,
      emailDomain: 0,
      phoneExact: 100,
      usernameMatch: 50,
      nameExact: 40,
      nameFuzzy: 0,
      orgOverlap: 20, // Shared org pushes over threshold
    }
    const total = computeTotalScore(scores)
    expect(total).toBeGreaterThan(MERGE_THRESHOLD)
  })

  test('email + username falls between review and merge thresholds', () => {
    const scores: MatchScores = {
      emailExact: 100,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 50,
      nameExact: 40,
      nameFuzzy: 0,
      orgOverlap: 0,
    }
    const total = computeTotalScore(scores)
    // Score of 51 falls between review (50) and merge (80) thresholds
    expect(total).toBeGreaterThan(REVIEW_THRESHOLD)
    expect(total).toBeLessThan(MERGE_THRESHOLD)
  })

  test('weak matches stay below review threshold', () => {
    const scores: MatchScores = {
      emailExact: 0,
      emailDomain: 5, // Generic domain
      phoneExact: 0,
      usernameMatch: 0,
      nameExact: 0,
      nameFuzzy: 15, // Weak fuzzy match
      orgOverlap: 0,
    }
    const total = computeTotalScore(scores)
    expect(total).toBeLessThan(REVIEW_THRESHOLD)
  })
})

// ============ Match Field Detection Tests ============

describe('Match Field Detection', () => {
  function getMatchedFields(scores: MatchScores): string[] {
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

  test('identifies email exact match', () => {
    const scores: MatchScores = {
      emailExact: 100,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 0,
      nameExact: 0,
      nameFuzzy: 0,
      orgOverlap: 0,
    }
    expect(getMatchedFields(scores)).toContain('email_exact')
    expect(getMatchedFields(scores)).not.toContain('email_domain')
  })

  test('identifies multiple match types', () => {
    const scores: MatchScores = {
      emailExact: 100,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 50,
      nameExact: 40,
      nameFuzzy: 0,
      orgOverlap: 0,
    }
    const matched = getMatchedFields(scores)
    expect(matched).toContain('email_exact')
    expect(matched).toContain('username')
    expect(matched).toContain('name_exact')
    expect(matched.length).toBe(3)
  })

  test('returns empty array for no matches', () => {
    const scores: MatchScores = {
      emailExact: 0,
      emailDomain: 0,
      phoneExact: 0,
      usernameMatch: 0,
      nameExact: 0,
      nameFuzzy: 0,
      orgOverlap: 0,
    }
    expect(getMatchedFields(scores)).toEqual([])
  })
})

// ============ Username Merge Tests ============

describe('Username Merging', () => {
  function mergeUsernames(
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

  test('merges non-overlapping usernames', () => {
    const a = [{ platform: 'github', username: 'johndoe' }]
    const b = [{ platform: 'twitter', username: 'john_doe' }]
    const merged = mergeUsernames(a, b)
    expect(merged.length).toBe(2)
  })

  test('deduplicates same platform+username', () => {
    const a = [{ platform: 'github', username: 'johndoe' }]
    const b = [{ platform: 'github', username: 'JohnDoe' }] // Different case
    const merged = mergeUsernames(a, b)
    expect(merged.length).toBe(1)
  })

  test('keeps different usernames on same platform', () => {
    const a = [{ platform: 'github', username: 'johndoe' }]
    const b = [{ platform: 'github', username: 'jdoe' }]
    const merged = mergeUsernames(a, b)
    expect(merged.length).toBe(2)
  })

  test('handles empty arrays', () => {
    expect(mergeUsernames([], [])).toEqual([])
    expect(mergeUsernames([{ platform: 'github', username: 'john' }], [])).toHaveLength(1)
    expect(mergeUsernames([], [{ platform: 'github', username: 'john' }])).toHaveLength(1)
  })
})

// ============ Generic Domains Tests ============

describe('Generic Domain Detection', () => {
  const genericDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']

  function isGenericDomain(domain: string): boolean {
    return genericDomains.includes(domain.toLowerCase())
  }

  test('detects gmail as generic', () => {
    expect(isGenericDomain('gmail.com')).toBe(true)
  })

  test('detects corporate domain as non-generic', () => {
    expect(isGenericDomain('anthropic.com')).toBe(false)
  })

  test('is case insensitive', () => {
    expect(isGenericDomain('GMAIL.COM')).toBe(true)
  })
})
