import {
  generateCanonicalId,
  generateCanonicalIdBatch,
  extractTimestamp,
  isValidUlid,
  sourceRefToKey,
  parseSourceRefKey,
  computeIdempotencyKeys,
  computeRawDataHash,
  compareUlids,
  olderUlid,
  newerUlid,
  UlidSchema,
  SourceRefSchema,
  type SourceRef,
} from 'agent-memory/ids.js'
import { stableStringify } from 'agent-memory/stable-stringify.js'

describe('ID System', () => {
  describe('generateCanonicalId', () => {
    test('generates valid ULID', () => {
      const id = generateCanonicalId()
      expect(isValidUlid(id)).toBe(true)
      expect(id).toHaveLength(26)
    })

    test('generates unique IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i++) {
        ids.add(generateCanonicalId())
      }
      expect(ids.size).toBe(1000)
    })

    test('generates monotonically increasing IDs', () => {
      const id1 = generateCanonicalId()
      const id2 = generateCanonicalId()
      expect(id1 < id2).toBe(true)
    })
  })

  describe('generateCanonicalIdBatch', () => {
    test('generates correct number of IDs', () => {
      const ids = generateCanonicalIdBatch(100)
      expect(ids).toHaveLength(100)
      ids.forEach(id => expect(isValidUlid(id)).toBe(true))
    })
  })

  describe('extractTimestamp', () => {
    test('extracts timestamp from ULID', () => {
      const before = Date.now()
      const id = generateCanonicalId()
      const after = Date.now()

      const timestamp = extractTimestamp(id)
      expect(timestamp).toBeGreaterThanOrEqual(before)
      expect(timestamp).toBeLessThanOrEqual(after)
    })
  })

  describe('isValidUlid', () => {
    test('validates correct ULIDs', () => {
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true)
      expect(isValidUlid(generateCanonicalId())).toBe(true)
    })

    test('rejects invalid ULIDs', () => {
      expect(isValidUlid('')).toBe(false)
      expect(isValidUlid('too-short')).toBe(false)
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVI')).toBe(false) // too long
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAi')).toBe(false) // lowercase
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toBe(false) // contains O
    })
  })

  describe('UlidSchema', () => {
    test('validates correct ULIDs', () => {
      expect(UlidSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true)
    })

    test('rejects invalid ULIDs', () => {
      expect(UlidSchema.safeParse('invalid').success).toBe(false)
    })
  })

  describe('sourceRefToKey', () => {
    test('creates deterministic key from source ref', () => {
      const ref: SourceRef = {
        connector: 'github',
        account_id: 'user123',
        entity_type: 'issue',
        source_id: '456',
      }

      expect(sourceRefToKey(ref)).toBe('github:user123:issue:456')
    })

    test('handles source_ids with colons', () => {
      const ref: SourceRef = {
        connector: 'gmail',
        account_id: 'user@example.com',
        entity_type: 'message',
        source_id: 'msg:abc:123',
      }

      expect(sourceRefToKey(ref)).toBe('gmail:user@example.com:message:msg:abc:123')
    })
  })

  describe('parseSourceRefKey', () => {
    test('parses valid keys', () => {
      const result = parseSourceRefKey('github:user123:issue:456')
      expect(result).toEqual({
        connector: 'github',
        account_id: 'user123',
        entity_type: 'issue',
        source_id: '456',
      })
    })

    test('handles source_ids with colons', () => {
      const result = parseSourceRefKey('gmail:user@example.com:message:msg:abc:123')
      expect(result).toEqual({
        connector: 'gmail',
        account_id: 'user@example.com',
        entity_type: 'message',
        source_id: 'msg:abc:123',
      })
    })

    test('returns null for invalid keys', () => {
      expect(parseSourceRefKey('invalid')).toBe(null)
      expect(parseSourceRefKey('invalid:key')).toBe(null)
      expect(parseSourceRefKey('unknown:a:b:c')).toBe(null) // invalid connector
    })

    test('roundtrips with sourceRefToKey', () => {
      const ref: SourceRef = {
        connector: 'xcom',
        account_id: 'handle123',
        entity_type: 'tweet',
        source_id: '1234567890',
      }

      const key = sourceRefToKey(ref)
      const parsed = parseSourceRefKey(key)

      expect(parsed).toEqual({
        connector: ref.connector,
        account_id: ref.account_id,
        entity_type: ref.entity_type,
        source_id: ref.source_id,
      })
    })
  })

  describe('SourceRefSchema', () => {
    test('validates correct source refs', () => {
      const ref = {
        connector: 'github',
        account_id: 'user123',
        entity_type: 'issue',
        source_id: '456',
      }
      expect(SourceRefSchema.safeParse(ref).success).toBe(true)
    })

    test('rejects invalid connector', () => {
      const ref = {
        connector: 'invalid',
        account_id: 'user123',
        entity_type: 'issue',
        source_id: '456',
      }
      expect(SourceRefSchema.safeParse(ref).success).toBe(false)
    })

    test('rejects empty strings', () => {
      const ref = {
        connector: 'github',
        account_id: '',
        entity_type: 'issue',
        source_id: '456',
      }
      expect(SourceRefSchema.safeParse(ref).success).toBe(false)
    })
  })

  describe('computeIdempotencyKeys', () => {
    test('generates consistent keys for same input', () => {
      const rawData = { title: 'Test Issue', number: 123 }

      const keys1 = computeIdempotencyKeys('github', 'user123', 'issue', '456', rawData)
      const keys2 = computeIdempotencyKeys('github', 'user123', 'issue', '456', rawData)

      expect(keys1.raw_key).toBe(keys2.raw_key)
      expect(keys1.entity_key).toBe(keys2.entity_key)
    })

    test('entity_key matches sourceRefToKey format', () => {
      const keys = computeIdempotencyKeys('github', 'user123', 'issue', '456', {})
      expect(keys.entity_key).toBe('github:user123:issue:456')
    })

    test('different raw data produces different raw_key', () => {
      const keys1 = computeIdempotencyKeys('github', 'user123', 'issue', '456', { a: 1 })
      const keys2 = computeIdempotencyKeys('github', 'user123', 'issue', '456', { a: 2 })

      expect(keys1.entity_key).toBe(keys2.entity_key) // Same entity
      expect(keys1.raw_key).not.toBe(keys2.raw_key) // Different raw data
    })
  })

  describe('computeRawDataHash', () => {
    test('produces consistent hash', () => {
      const data = { foo: 'bar', nested: { a: 1, b: 2 } }
      const hash1 = computeRawDataHash(data)
      const hash2 = computeRawDataHash(data)
      expect(hash1).toBe(hash2)
    })

    test('object key order does not affect hash', () => {
      const data1 = { a: 1, b: 2 }
      const data2 = { b: 2, a: 1 }
      expect(computeRawDataHash(data1)).toBe(computeRawDataHash(data2))
    })
  })

  describe('stableStringify', () => {
    test('produces deterministic output', () => {
      const obj1 = { z: 1, a: 2, m: 3 }
      const obj2 = { a: 2, m: 3, z: 1 }
      expect(stableStringify(obj1)).toBe(stableStringify(obj2))
    })

    test('handles nested objects', () => {
      const obj1 = { outer: { z: 1, a: 2 } }
      const obj2 = { outer: { a: 2, z: 1 } }
      expect(stableStringify(obj1)).toBe(stableStringify(obj2))
    })

    test('handles arrays (order preserved)', () => {
      const arr1 = [1, 2, 3]
      const arr2 = [1, 2, 3]
      expect(stableStringify(arr1)).toBe(stableStringify(arr2))
      expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
    })

    test('handles null and primitives', () => {
      expect(stableStringify(null)).toBe('null')
      expect(stableStringify(42)).toBe('42')
      expect(stableStringify('hello')).toBe('"hello"')
      expect(stableStringify(true)).toBe('true')
    })
  })

  describe('ULID comparison', () => {
    test('compareUlids orders correctly', () => {
      const id1 = generateCanonicalId()
      const id2 = generateCanonicalId()

      expect(compareUlids(id1, id2)).toBeLessThan(0)
      expect(compareUlids(id2, id1)).toBeGreaterThan(0)
      expect(compareUlids(id1, id1)).toBe(0)
    })

    test('olderUlid returns the older ID', () => {
      const id1 = generateCanonicalId()
      const id2 = generateCanonicalId()

      expect(olderUlid(id1, id2)).toBe(id1)
      expect(olderUlid(id2, id1)).toBe(id1)
    })

    test('newerUlid returns the newer ID', () => {
      const id1 = generateCanonicalId()
      const id2 = generateCanonicalId()

      expect(newerUlid(id1, id2)).toBe(id2)
      expect(newerUlid(id2, id1)).toBe(id2)
    })
  })
})
