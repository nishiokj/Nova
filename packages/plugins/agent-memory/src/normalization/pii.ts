/**
 * PII Detection
 *
 * Detects potentially sensitive information (PII) in text.
 * Supports detection and optional redaction.
 */

import type { PIIType, PIIOptions, DetectedPII } from './types.js'
import { DEFAULT_PII_OPTIONS } from './types.js'

// ============ PII Patterns ============

/**
 * PII detection patterns with confidence scores.
 */
interface PIIPattern {
  type: PIIType
  pattern: RegExp
  confidence: number
  validate?: (match: string) => boolean
}

/**
 * Email pattern - standard email format.
 */
const EMAIL_PATTERN: PIIPattern = {
  type: 'email',
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  confidence: 0.95,
  validate: (match) => {
    // Exclude common non-personal patterns (automated/system emails)
    const nonPersonal = [
      'noreply@', 'no-reply@', 'donotreply@',
      'localhost',
    ]
    const lower = match.toLowerCase()
    return !nonPersonal.some(p => lower.includes(p))
  },
}

/**
 * Phone number patterns - various formats.
 */
const PHONE_PATTERN: PIIPattern = {
  type: 'phone',
  pattern: /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  confidence: 0.85,
  validate: (match) => {
    // Must have at least 10 digits
    const digits = match.replace(/\D/g, '')
    return digits.length >= 10 && digits.length <= 15
  },
}

/**
 * Credit card pattern - major card formats.
 * Matches 13-19 digit numbers with optional separators.
 */
const CREDIT_CARD_PATTERN: PIIPattern = {
  type: 'credit_card',
  pattern: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g,
  confidence: 0.8,
  validate: (match) => {
    const digits = match.replace(/\D/g, '')
    // Check length and Luhn algorithm
    if (digits.length < 13 || digits.length > 19) {
      return false
    }
    return luhnCheck(digits)
  },
}

/**
 * SSN pattern - US Social Security Number.
 */
const SSN_PATTERN: PIIPattern = {
  type: 'ssn',
  pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  confidence: 0.75,
  validate: (match) => {
    const digits = match.replace(/\D/g, '')
    if (digits.length !== 9) {
      return false
    }
    // Exclude invalid SSN patterns
    const area = parseInt(digits.substring(0, 3), 10)
    const group = parseInt(digits.substring(3, 5), 10)
    const serial = parseInt(digits.substring(5), 10)
    // Area cannot be 000, 666, or 900-999
    if (area === 0 || area === 666 || area >= 900) {
      return false
    }
    // Group and serial cannot be 0
    if (group === 0 || serial === 0) {
      return false
    }
    return true
  },
}

/**
 * IP address pattern - IPv4.
 */
const IP_ADDRESS_PATTERN: PIIPattern = {
  type: 'ip_address',
  pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  confidence: 0.9,
  validate: (match) => {
    // Exclude local/private IPs
    const parts = match.split('.').map(Number)
    // 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 0.0.0.0
    if (parts[0] === 127 || parts[0] === 10) {
      return false
    }
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
      return false
    }
    if (parts[0] === 192 && parts[1] === 168) {
      return false
    }
    if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) {
      return false
    }
    return true
  },
}

/**
 * Date of birth pattern - common formats.
 * Lower confidence as dates are common and often not DOB.
 */
const DOB_PATTERN: PIIPattern = {
  type: 'date_of_birth',
  pattern: /\b(?:DOB|D\.O\.B\.?|born|birthday|birth date)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/gi,
  confidence: 0.7,
  validate: () => true,
}

/**
 * All PII patterns indexed by type.
 */
const PII_PATTERNS: Record<PIIType, PIIPattern> = {
  email: EMAIL_PATTERN,
  phone: PHONE_PATTERN,
  credit_card: CREDIT_CARD_PATTERN,
  ssn: SSN_PATTERN,
  ip_address: IP_ADDRESS_PATTERN,
  date_of_birth: DOB_PATTERN,
}

// ============ Validation Helpers ============

/**
 * Luhn algorithm for credit card validation.
 */
function luhnCheck(digits: string): boolean {
  let sum = 0
  let isEven = false

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10)

    if (isEven) {
      digit *= 2
      if (digit > 9) {
        digit -= 9
      }
    }

    sum += digit
    isEven = !isEven
  }

  return sum % 10 === 0
}

// ============ Detection ============

/**
 * Detect PII in text.
 */
export function detectPII(text: string, options: PIIOptions = {}): DetectedPII[] {
  const opts = { ...DEFAULT_PII_OPTIONS, ...options }

  if (!text || typeof text !== 'string') {
    return []
  }

  const detected: DetectedPII[] = []
  const typesToCheck = opts.types || Object.keys(PII_PATTERNS) as PIIType[]

  for (const type of typesToCheck) {
    const patternDef = PII_PATTERNS[type]
    if (!patternDef) continue

    // Reset regex state
    const pattern = new RegExp(patternDef.pattern.source, patternDef.pattern.flags)

    let match
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1] || match[0] // Use capture group if present

      // Run validation
      if (patternDef.validate && !patternDef.validate(value)) {
        continue
      }

      // Check confidence threshold
      if (patternDef.confidence < opts.minConfidence) {
        continue
      }

      detected.push({
        type,
        value,
        start: match.index,
        end: match.index + match[0].length,
        confidence: patternDef.confidence,
      })
    }
  }

  // Sort by position
  detected.sort((a, b) => a.start - b.start)

  // Remove overlapping detections (keep higher confidence)
  return removeOverlapping(detected)
}

/**
 * Remove overlapping PII detections, keeping higher confidence ones.
 */
function removeOverlapping(items: DetectedPII[]): DetectedPII[] {
  if (items.length <= 1) {
    return items
  }

  const result: DetectedPII[] = []
  let lastEnd = -1

  for (const item of items) {
    if (item.start >= lastEnd) {
      result.push(item)
      lastEnd = item.end
    } else {
      // Overlap - check if current has higher confidence
      const last = result[result.length - 1]
      if (last && item.confidence > last.confidence) {
        result[result.length - 1] = item
        lastEnd = item.end
      }
    }
  }

  return result
}

// ============ Redaction ============

/**
 * Redact detected PII from text.
 */
export function redactPII(text: string, options: PIIOptions = {}): { text: string; redacted: DetectedPII[] } {
  const opts = { ...DEFAULT_PII_OPTIONS, ...options, redact: true }
  const redactionString = opts.redactionString

  const detected = detectPII(text, opts)
  if (detected.length === 0) {
    return { text, redacted: [] }
  }

  // Build redacted text
  let result = ''
  let lastIndex = 0

  for (const item of detected) {
    result += text.substring(lastIndex, item.start)
    result += redactionString
    lastIndex = item.end
  }

  result += text.substring(lastIndex)

  return { text: result, redacted: detected }
}

/**
 * Mask PII partially (e.g., show first/last characters).
 */
export function maskPII(
  text: string,
  options: PIIOptions = {},
  maskChar = '*',
  visibleChars = 2
): { text: string; masked: DetectedPII[] } {
  const opts = { ...DEFAULT_PII_OPTIONS, ...options }

  const detected = detectPII(text, opts)
  if (detected.length === 0) {
    return { text, masked: [] }
  }

  let result = ''
  let lastIndex = 0

  for (const item of detected) {
    result += text.substring(lastIndex, item.start)

    const value = item.value
    if (value.length <= visibleChars * 2) {
      // Too short to partially mask
      result += maskChar.repeat(value.length)
    } else {
      const start = value.substring(0, visibleChars)
      const end = value.substring(value.length - visibleChars)
      const middle = maskChar.repeat(value.length - visibleChars * 2)
      result += start + middle + end
    }

    lastIndex = item.end
  }

  result += text.substring(lastIndex)

  return { text: result, masked: detected }
}

// ============ Analysis ============

/**
 * Analyze text for PII and return a summary.
 */
export function analyzePII(text: string, options: PIIOptions = {}): {
  hasPII: boolean
  types: PIIType[]
  count: number
  items: DetectedPII[]
  riskLevel: 'none' | 'low' | 'medium' | 'high'
} {
  const items = detectPII(text, options)

  const types = [...new Set(items.map(i => i.type))]

  // Determine risk level based on what was found
  let riskLevel: 'none' | 'low' | 'medium' | 'high' = 'none'
  if (items.length > 0) {
    const hasHighRisk = items.some(i =>
      i.type === 'ssn' || i.type === 'credit_card'
    )
    const hasMediumRisk = items.some(i =>
      i.type === 'phone' || i.type === 'date_of_birth'
    )

    if (hasHighRisk) {
      riskLevel = 'high'
    } else if (hasMediumRisk) {
      riskLevel = 'medium'
    } else {
      riskLevel = 'low'
    }
  }

  return {
    hasPII: items.length > 0,
    types,
    count: items.length,
    items,
    riskLevel,
  }
}

/**
 * Check if text contains any PII.
 */
export function containsPII(text: string, options: PIIOptions = {}): boolean {
  return detectPII(text, options).length > 0
}
