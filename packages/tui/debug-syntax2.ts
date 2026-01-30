/**
 * Debug script to see ALL children (including unnamed)
 */

import { createParser, type SupportedLanguage } from 'entity-graph'

const code = `function hello(name: string): string {
  return "Hello!"
}`

const parser = createParser('typescript' as SupportedLanguage)
const tree = parser.parse(code)

// Walk and print ALL children
function walk(node: any, depth = 0) {
  const indent = '  '.repeat(depth)
  const textPreview = node.text.length > 40
    ? node.text.slice(0, 40) + '...'
    : node.text
  const textClean = textPreview.replace(/\n/g, '\\n').replace(/\s+/g, ' ')
  console.log(`${indent}${node.type}: "${textClean}"`)

  // Print ALL children (named and unnamed)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    walk(child, depth + 1)
  }
}

console.log('Full tree (named + unnamed):')
walk(tree.rootNode)
