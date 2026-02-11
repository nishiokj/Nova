/**
 * Test suite for Tree-sitter syntax highlighting
 */

import { describe, it, expect } from 'bun:test'
import { highlightCode, isLanguageSupported } from './utils/syntax.js'

describe('Syntax Highlighting', () => {
  describe('language detection', () => {
    it('detects TypeScript from "typescript"', () => {
      expect(isLanguageSupported('typescript')).toBe(true)
    })

    it('detects TypeScript from "ts"', () => {
      expect(isLanguageSupported('ts')).toBe(true)
    })

    it('detects JavaScript from "javascript"', () => {
      expect(isLanguageSupported('javascript')).toBe(true)
    })

    it('detects JavaScript from "js"', () => {
      expect(isLanguageSupported('js')).toBe(true)
    })

    it('detects JSX from "jsx"', () => {
      expect(isLanguageSupported('jsx')).toBe(true)
    })

    it('detects TSX from "tsx"', () => {
      expect(isLanguageSupported('tsx')).toBe(true)
    })

    it('returns false for unsupported languages', () => {
      expect(isLanguageSupported('python')).toBe(false)
      expect(isLanguageSupported('ruby')).toBe(false)
      expect(isLanguageSupported('go')).toBe(false)
    })
  })

  describe('basic highlighting', () => {
    it('highlights TypeScript code', () => {
      const code = `function hello(name: string): string {
  return \`Hello, \${name}!\`
}`
      const result = highlightCode(code, 'typescript')
      expect(result).toBeTruthy()
      expect(result.length).toBeGreaterThan(0)
      // Should contain ANSI escape codes
      expect(result).toContain('\x1b[')
    })

    it('highlights JavaScript code', () => {
      const code = `const x = 42
function add(a, b) {
  return a + b
}`
      const result = highlightCode(code, 'javascript')
      expect(result).toBeTruthy()
      expect(result).toContain('\x1b[')
    })

    it('handles empty code', () => {
      const result = highlightCode('', 'typescript')
      expect(result).toBe('')
    })

    it('handles null/undefined code', () => {
      expect(highlightCode(null as any, 'typescript')).toBe('')
      expect(highlightCode(undefined as any, 'typescript')).toBe('')
    })
  })

  describe('keyword highlighting', () => {
    it('highlights function keyword', () => {
      const code = 'function test() {}'
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('function')
      // Should have ANSI codes
      expect(result).toContain('\x1b[')
    })

    it('highlights const keyword', () => {
      const code = 'const x = 1'
      const result = highlightCode(code, 'javascript')
      expect(result).toContain('const')
      expect(result).toContain('\x1b[')
    })

    it('highlights return keyword', () => {
      const code = 'return 42'
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('return')
      expect(result).toContain('\x1b[')
    })

    it('highlights if keyword', () => {
      const code = 'if (true) {}'
      const result = highlightCode(code, 'javascript')
      expect(result).toContain('if')
      expect(result).toContain('\x1b[')
    })
  })

  describe('string highlighting', () => {
    it('highlights single-quoted strings', () => {
      const code = `const name = 'Alice'`
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('Alice')
      expect(result).toContain('\x1b[')
    })

    it('highlights double-quoted strings', () => {
      const code = `const name = "Bob"`
      const result = highlightCode(code, 'javascript')
      expect(result).toContain('Bob')
      expect(result).toContain('\x1b[')
    })

    it('highlights template strings', () => {
      const code = `const greeting = \`Hello\``
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('Hello')
      expect(result).toContain('\x1b[')
    })
  })

  describe('number highlighting', () => {
    it('highlights integers', () => {
      const code = `const x = 42`
      const result = highlightCode(code, 'javascript')
      expect(result).toContain('42')
      expect(result).toContain('\x1b[')
    })

    it('highlights floats', () => {
      const code = `const pi = 3.14`
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('3.14')
      expect(result).toContain('\x1b[')
    })
  })

  describe('comment highlighting', () => {
    it('highlights single-line comments', () => {
      const code = `// This is a comment`
      const result = highlightCode(code, 'javascript')
      expect(result).toContain('This is a comment')
      expect(result).toContain('\x1b[')
    })

    it('highlights multi-line comments', () => {
      const code = `/* This is a multi-line comment */`
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('This is a multi-line comment')
      expect(result).toContain('\x1b[')
    })
  })

  describe('function highlighting', () => {
    it('highlights function names', () => {
      const code = `function myFunction() {}`
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('myFunction')
      expect(result).toContain('\x1b[')
    })

    it('highlights arrow functions', () => {
      const code = `const add = (a: number, b: number) => a + b`
      const result = highlightCode(code, 'typescript')
      expect(result).toContain('add')
      expect(result).toContain('\x1b[')
    })
  })

  describe('fallback behavior', () => {
    it('falls back to plain code for unsupported languages', () => {
      const code = `def hello():\n    print("world")`
      const result = highlightCode(code, 'python')
      expect(result).toBe(code)
      expect(result).not.toContain('\x1b[')
    })

    it('falls back to plain code when no language is specified', () => {
      const code = `const x = 42`
      const result = highlightCode(code, undefined)
      expect(result).toBe(code)
      expect(result).not.toContain('\x1b[')
    })
  })

  describe('multi-line code', () => {
    it('preserves newlines', () => {
      const code = `const x = 1
const y = 2
const z = x + y`
      const result = highlightCode(code, 'typescript')
      const lines = result.split('\n')
      expect(lines.length).toBe(3)
    })

    it('highlights each line separately', () => {
      const code = `function add(a, b) {
  return a + b
}`
      const result = highlightCode(code, 'javascript')
      // Each line should have some coloring
      const lines = result.split('\n')
      lines.forEach(line => {
        if (line.trim()) {
          expect(line).toContain('\x1b[')
        }
      })
    })
  })
})
