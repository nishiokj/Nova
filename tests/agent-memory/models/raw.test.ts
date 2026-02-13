import { generateCanonicalId, sourceRefToKey, computeRawDataHash } from 'agent-memory/ids.js'
import {
  CollectionMethodSchema,
  RawEnvelopeSchema,
  EntitySourceMappingSchema,
} from 'agent-memory/models/raw.js'

// Helper to create a valid raw envelope
function createRawEnvelope(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: generateCanonicalId(),
    idempotency_key: 'abc123def456',
    connector: 'github',
    account_id: 'user123',
    entity_type: 'issue',
    source_id: '789',
    raw_data: { title: 'Test Issue', body: 'Description' },
    raw_data_hash: computeRawDataHash({ title: 'Test Issue', body: 'Description' }),
    received_at: now,
    sync_job_id: generateCanonicalId(),
    collection_method: 'incremental',
    ...overrides,
  }
}

// Helper to create a valid entity source mapping
function createEntitySourceMapping(overrides = {}) {
  const now = new Date().toISOString()
  const canonicalId = generateCanonicalId()
  const rawEnvelopeId = generateCanonicalId()
  return {
    id: generateCanonicalId(),
    canonical_entity_id: canonicalId,
    canonical_entity_type: 'issue',
    raw_envelope_id: rawEnvelopeId,
    source_ref_key: sourceRefToKey({
      connector: 'github',
      account_id: 'user123',
      entity_type: 'issue',
      source_id: '789',
    }),
    created_at: now,
    ...overrides,
  }
}

describe('Raw Envelope & Lineage', () => {
  describe('CollectionMethodSchema', () => {
    test('accepts valid collection methods', () => {
      expect(CollectionMethodSchema.safeParse('backfill').success).toBe(true)
      expect(CollectionMethodSchema.safeParse('incremental').success).toBe(true)
      expect(CollectionMethodSchema.safeParse('webhook').success).toBe(true)
      expect(CollectionMethodSchema.safeParse('manual').success).toBe(true)
    })

    test('rejects invalid collection methods', () => {
      expect(CollectionMethodSchema.safeParse('auto').success).toBe(false)
      expect(CollectionMethodSchema.safeParse('realtime').success).toBe(false)
      expect(CollectionMethodSchema.safeParse('').success).toBe(false)
    })
  })

  describe('RawEnvelopeSchema', () => {
    test('validates correct raw envelope', () => {
      const envelope = createRawEnvelope()
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(true)
    })

    test('validates envelope with all optional fields', () => {
      const envelope = createRawEnvelope({
        source_version: 'v1.2.3',
        source_timestamp: new Date().toISOString(),
        processed_at: new Date().toISOString(),
      })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(true)
    })

    test('validates envelope with processing error', () => {
      const envelope = createRawEnvelope({
        processing_error: 'Failed to normalize: missing required field',
      })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(true)
    })

    test('requires idempotency_key', () => {
      const envelope = createRawEnvelope()
      delete (envelope as Record<string, unknown>).idempotency_key
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires non-empty idempotency_key', () => {
      const envelope = createRawEnvelope({ idempotency_key: '' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires connector', () => {
      const envelope = createRawEnvelope()
      delete (envelope as Record<string, unknown>).connector
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('validates connector type', () => {
      const envelope = createRawEnvelope({ connector: 'invalid_connector' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('validates all connector types', () => {
      for (const connector of ['github', 'gmail', 'xcom', 'imessage']) {
        const envelope = createRawEnvelope({ connector })
        const result = RawEnvelopeSchema.safeParse(envelope)
        expect(result.success).toBe(true)
      }
    })

    test('requires account_id', () => {
      const envelope = createRawEnvelope({ account_id: '' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires entity_type', () => {
      const envelope = createRawEnvelope({ entity_type: '' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires source_id', () => {
      const envelope = createRawEnvelope({ source_id: '' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires raw_data_hash', () => {
      const envelope = createRawEnvelope({ raw_data_hash: '' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires received_at datetime', () => {
      const envelope = createRawEnvelope({ received_at: 'not-a-date' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('validates source_timestamp datetime format', () => {
      const envelope = createRawEnvelope({ source_timestamp: 'invalid-date' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('validates processed_at datetime format', () => {
      const envelope = createRawEnvelope({ processed_at: 'invalid-date' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires sync_job_id', () => {
      const envelope = createRawEnvelope()
      delete (envelope as Record<string, unknown>).sync_job_id
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('validates sync_job_id ULID format', () => {
      const envelope = createRawEnvelope({ sync_job_id: 'invalid-ulid' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('requires collection_method', () => {
      const envelope = createRawEnvelope()
      delete (envelope as Record<string, unknown>).collection_method
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('validates collection_method enum', () => {
      const envelope = createRawEnvelope({ collection_method: 'auto' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })

    test('accepts any raw_data type', () => {
      // String
      expect(RawEnvelopeSchema.safeParse(createRawEnvelope({ raw_data: 'test' })).success).toBe(true)
      // Number
      expect(RawEnvelopeSchema.safeParse(createRawEnvelope({ raw_data: 123 })).success).toBe(true)
      // Array
      expect(RawEnvelopeSchema.safeParse(createRawEnvelope({ raw_data: [1, 2, 3] })).success).toBe(true)
      // Object
      expect(RawEnvelopeSchema.safeParse(createRawEnvelope({ raw_data: { nested: { deep: true } } })).success).toBe(true)
      // Null
      expect(RawEnvelopeSchema.safeParse(createRawEnvelope({ raw_data: null })).success).toBe(true)
    })

    test('validates id ULID format', () => {
      const envelope = createRawEnvelope({ id: 'invalid-ulid' })
      const result = RawEnvelopeSchema.safeParse(envelope)
      expect(result.success).toBe(false)
    })
  })

  describe('EntitySourceMappingSchema', () => {
    test('validates correct mapping', () => {
      const mapping = createEntitySourceMapping()
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(true)
    })

    test('applies default mapping_confidence of 1.0', () => {
      const mapping = createEntitySourceMapping()
      const result = EntitySourceMappingSchema.parse(mapping)
      expect(result.mapping_confidence).toBe(1.0)
    })

    test('accepts explicit mapping_confidence', () => {
      const mapping = createEntitySourceMapping({ mapping_confidence: 0.75 })
      const result = EntitySourceMappingSchema.parse(mapping)
      expect(result.mapping_confidence).toBe(0.75)
    })

    test('validates mapping_confidence minimum (0)', () => {
      const mapping = createEntitySourceMapping({ mapping_confidence: -0.1 })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('validates mapping_confidence maximum (1)', () => {
      const mapping = createEntitySourceMapping({ mapping_confidence: 1.1 })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('accepts boundary confidence values', () => {
      expect(EntitySourceMappingSchema.safeParse(createEntitySourceMapping({ mapping_confidence: 0 })).success).toBe(true)
      expect(EntitySourceMappingSchema.safeParse(createEntitySourceMapping({ mapping_confidence: 1 })).success).toBe(true)
    })

    test('requires canonical_entity_id', () => {
      const mapping = createEntitySourceMapping()
      delete (mapping as Record<string, unknown>).canonical_entity_id
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('validates canonical_entity_id ULID format', () => {
      const mapping = createEntitySourceMapping({ canonical_entity_id: 'invalid' })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('requires canonical_entity_type', () => {
      const mapping = createEntitySourceMapping({ canonical_entity_type: '' })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('requires raw_envelope_id', () => {
      const mapping = createEntitySourceMapping()
      delete (mapping as Record<string, unknown>).raw_envelope_id
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('validates raw_envelope_id ULID format', () => {
      const mapping = createEntitySourceMapping({ raw_envelope_id: 'bad-id' })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('requires source_ref_key', () => {
      const mapping = createEntitySourceMapping({ source_ref_key: '' })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('requires created_at', () => {
      const mapping = createEntitySourceMapping()
      delete (mapping as Record<string, unknown>).created_at
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('validates created_at datetime format', () => {
      const mapping = createEntitySourceMapping({ created_at: 'not-valid' })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })

    test('validates id ULID format', () => {
      const mapping = createEntitySourceMapping({ id: 'bad-ulid' })
      const result = EntitySourceMappingSchema.safeParse(mapping)
      expect(result.success).toBe(false)
    })
  })
})
