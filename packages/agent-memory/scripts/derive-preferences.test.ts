import { describe, test, expect } from 'bun:test'
import {
  chunkByBytes,
  extractJsonArray,
  dedupePreferences,
  roleFromMessage,
  formatTranscript,
} from './derive_preferences.js'

describe('derive_preferences helpers', () => {
  test('chunkByBytes splits on byte limit without dropping lines', () => {
    const text = ['one', 'two', 'three', 'four'].join('\n')
    const chunks = chunkByBytes(text, 10)
    const rejoined = chunks.join('\n')
    expect(rejoined).toBe(text)
    expect(chunks.length).toBeGreaterThan(1)
  })

  test('extractJsonArray finds the last JSON array in text', () => {
    const text = 'prefix [ {"preference":"A"} ] suffix'
    const parsed = extractJsonArray(text)
    expect(parsed).toBeArray()
    expect(parsed?.length).toBe(1)
    expect(parsed?.[0]?.preference).toBe('A')
  })

  test('dedupePreferences drops empty and case-duplicates', () => {
    const prefs = [
      { preference: 'Use pnpm' },
      { preference: 'use pnpm' },
      { preference: '' },
    ]
    const result = dedupePreferences(prefs)
    expect(result.length).toBe(1)
    expect(result[0].preference).toBe('Use pnpm')
  })

  test('roleFromMessage uses metadata.role over labels', () => {
    const message = {
      metadata: { role: 'assistant' },
      labels: ['user'],
    }
    expect(roleFromMessage(message)).toBe('assistant')
  })

  test('roleFromMessage falls back to labels', () => {
    const message = {
      labels: ['user'],
    }
    expect(roleFromMessage(message)).toBe('user')
  })

  test('formatTranscript formats roles in uppercase', () => {
    const formatted = formatTranscript([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi' },
    ])
    expect(formatted).toBe('USER: Hello\nASSISTANT: Hi')
  })
})
