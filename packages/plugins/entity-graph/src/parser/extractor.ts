/**
 * Entity Extractor
 *
 * Walks a tree-sitter syntax tree and produces Entity[] and Edge[] arrays.
 * Uses tree-sitter's Query API for pattern matching, with manual tree-walking
 * for exported/async flags and ownership relationships.
 */

import { statSync } from 'fs'
import path from 'path'
import type { Language, Node, Tree } from 'web-tree-sitter'
import { Query } from 'web-tree-sitter'
import type { Entity, Edge, ParseResult, EntityKind } from '../types.js'
import type { SupportedLanguage } from './parser.js'
import {
  CLASS_QUERY,
  FUNCTION_DECLARATION_QUERY,
  ARROW_FUNCTION_QUERY,
  METHOD_QUERY,
  INTERFACE_QUERY,
  TYPE_ALIAS_QUERY,
  ENUM_QUERY,
  NAMED_IMPORT_QUERY,
  DEFAULT_IMPORT_QUERY,
  NAMESPACE_IMPORT_QUERY,
  CALL_EXPRESSION_QUERY,
  EXTENDS_CLAUSE_QUERY,
  IMPLEMENTS_CLAUSE_QUERY,
} from './queries.js'

// --- Helpers ---

/**
 * Build a composite entity ID: `kind:filepath:name`
 */
export function entityId(kind: EntityKind, filepath: string, name: string): string {
  return `${kind}:${filepath}:${name}`
}

/**
 * Check if a node is inside an export_statement (export { ... }, export default, export const, etc.)
 */
function isExported(node: Node): boolean {
  let parent = node.parent
  while (parent) {
    if (parent.type === 'export_statement') return true
    // For class/function declarations that are direct children of export
    if (parent.type === 'program') break
    parent = parent.parent
  }
  return false
}

/**
 * Check if a function/method node has the `async` keyword.
 */
function isAsync(node: Node): boolean {
  // For function_declaration, arrow_function, method_definition:
  // the "async" keyword appears as a child token
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === 'async') return true
  }
  // Also check text prefix for arrow functions assigned via variable declarator
  if (node.type === 'arrow_function') {
    const parent = node.parent
    if (parent?.type === 'variable_declarator') {
      // Check the lexical_declaration grandparent for "async" before the arrow
      const text = node.text
      return text.startsWith('async')
    }
  }
  return false
}

/**
 * Strip quotes from a string literal node's text.
 */
function stripQuotes(text: string): string {
  if ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Get raw text for an entity, truncated to avoid storing huge class bodies.
 */
function getRawText(node: Node, maxLen = 2000): string | null {
  const text = node.text
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

// --- Import Resolution ---

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

/**
 * Resolve a module specifier to a file path relative to sourceRoot.
 * Returns null for bare specifiers (external packages) or unresolvable paths.
 */
function resolveImportSource(
  specifier: string,
  currentFilepath: string,
  sourceRoot: string
): string | null {
  // Bare specifiers are external packages
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null
  }

  const currentDir = path.dirname(path.resolve(sourceRoot, currentFilepath))
  const base = path.resolve(currentDir, specifier)

  // Try exact file, then with extensions, then as directory with index file
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map(ext => base + ext),
    ...RESOLVE_EXTENSIONS.map(ext => path.join(base, `index${ext}`)),
  ]

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return path.relative(sourceRoot, candidate)
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Resolve a callee name to a known entity ID in the current file.
 * Tries function, then method (any class). Returns null if unresolvable.
 */
function resolveCallTarget(
  calleeName: string,
  filepath: string,
  knownEntities: Set<string>
): string | null {
  // Try as a top-level function
  const funcId = entityId('function', filepath, calleeName)
  if (knownEntities.has(funcId)) return funcId

  // Try as a method on any class
  const methodSuffix = `.${calleeName}`
  for (const id of knownEntities) {
    if (id.startsWith('method:') && id.endsWith(methodSuffix)) {
      return id
    }
  }

  return null
}

// --- Query Runner ---

interface CaptureResult {
  name: string
  node: Node
}

/**
 * Run a tree-sitter query and return captures.
 */
function runQuery(language: Language, queryStr: string, rootNode: Node): CaptureResult[] {
  try {
    const q = new Query(language, queryStr)
    return q.captures(rootNode)
  } catch {
    // Query construction can fail for some grammar/query combinations
    return []
  }
}

// --- Main Extractor ---

/**
 * Extract entities and edges from a parsed syntax tree.
 *
 * @param tree - tree-sitter parse result
 * @param filepath - source file path (relative to source root)
 * @param language - which language grammar was used
 * @returns ParseResult with entities and edges
 */
export function extract(
  tree: Tree,
  filepath: string,
  _language: SupportedLanguage,
  tsLanguage: Language,
  sourceRoot: string
): ParseResult {
  const entities: Entity[] = []
  const edges: Edge[] = []
  const entitySet = new Set<string>() // dedup by ID

  const rootNode = tree.rootNode

  // --- File entity (always created) ---
  const fileId = entityId('file', filepath, filepath)
  entities.push({
    id: fileId,
    kind: 'file',
    name: filepath,
    filepath,
    startLine: 1,
    endLine: rootNode.endPosition.row + 1,
    exported: false,
    async: false,
    rawText: null,
  })
  entitySet.add(fileId)

  // Helper to add entity + owns edge
  function addEntity(
    kind: EntityKind,
    name: string,
    node: Node,
    ownerId?: string
  ): string {
    const id = entityId(kind, filepath, name)
    if (entitySet.has(id)) return id
    entitySet.add(id)

    entities.push({
      id,
      kind,
      name,
      filepath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
      async: isAsync(node),
      rawText: getRawText(node),
    })

    // Ownership edge (file owns class, class owns method, etc.)
    const owner = ownerId ?? fileId
    edges.push({ type: 'owns', sourceId: owner, targetId: id })

    return id
  }

  // --- Extract classes ---
  const classCaptures = runQuery(tsLanguage, CLASS_QUERY, rootNode)
  const classIds = new Map<string, string>() // className -> entityId

  for (const cap of classCaptures) {
    if (cap.name === 'class.name') {
      const className = cap.node.text
      const classNode = cap.node.parent! // class_declaration
      const id = addEntity('class', className, classNode)
      classIds.set(className, id)
    }
  }

  // --- Extract methods (need class context) ---
  const methodCaptures = runQuery(tsLanguage, METHOD_QUERY, rootNode)
  let currentMethodClass = ''

  for (const cap of methodCaptures) {
    if (cap.name === 'method.class_name') {
      currentMethodClass = cap.node.text
    } else if (cap.name === 'method.name') {
      const methodName = cap.node.text
      const methodNode = cap.node.parent! // method_definition
      const ownerId = classIds.get(currentMethodClass)
      addEntity('method', `${currentMethodClass}.${methodName}`, methodNode, ownerId)
    }
  }

  // --- Extract functions ---
  const funcCaptures = runQuery(tsLanguage, FUNCTION_DECLARATION_QUERY, rootNode)
  for (const cap of funcCaptures) {
    if (cap.name === 'func.name') {
      addEntity('function', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract arrow functions ---
  const arrowCaptures = runQuery(tsLanguage, ARROW_FUNCTION_QUERY, rootNode)
  for (const cap of arrowCaptures) {
    if (cap.name === 'arrow.name') {
      const arrowNode = cap.node.parent! // variable_declarator → lexical_declaration
      addEntity('function', cap.node.text, arrowNode.parent ?? arrowNode)
    }
  }

  // --- Extract interfaces ---
  const ifaceCaptures = runQuery(tsLanguage, INTERFACE_QUERY, rootNode)
  for (const cap of ifaceCaptures) {
    if (cap.name === 'iface.name') {
      addEntity('interface', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract type aliases ---
  const typeCaptures = runQuery(tsLanguage, TYPE_ALIAS_QUERY, rootNode)
  for (const cap of typeCaptures) {
    if (cap.name === 'type.name') {
      addEntity('type', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract enums ---
  const enumCaptures = runQuery(tsLanguage, ENUM_QUERY, rootNode)
  for (const cap of enumCaptures) {
    if (cap.name === 'enum.name') {
      addEntity('enum', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract import edges ---
  const namedImportCaptures = runQuery(tsLanguage, NAMED_IMPORT_QUERY, rootNode)
  let currentImportSymbol = ''

  for (const cap of namedImportCaptures) {
    if (cap.name === 'import.name') {
      currentImportSymbol = cap.node.text
    } else if (cap.name === 'import.source') {
      const source = stripQuotes(cap.node.text)
      const resolvedPath = resolveImportSource(source, filepath, sourceRoot)
      if (resolvedPath) {
        const importedFileId = entityId('file', resolvedPath, resolvedPath)
        edges.push({
          type: 'imports',
          sourceId: fileId,
          targetId: importedFileId,
          meta: { symbol: currentImportSymbol },
        })
      }
    }
  }

  const defaultImportCaptures = runQuery(tsLanguage, DEFAULT_IMPORT_QUERY, rootNode)
  for (const cap of defaultImportCaptures) {
    if (cap.name === 'import.source') {
      const source = stripQuotes(cap.node.text)
      const resolvedPath = resolveImportSource(source, filepath, sourceRoot)
      if (resolvedPath) {
        const importedFileId = entityId('file', resolvedPath, resolvedPath)
        edges.push({
          type: 'imports',
          sourceId: fileId,
          targetId: importedFileId,
          meta: { symbol: 'default' },
        })
      }
    }
  }

  const nsImportCaptures = runQuery(tsLanguage, NAMESPACE_IMPORT_QUERY, rootNode)
  for (const cap of nsImportCaptures) {
    if (cap.name === 'import.source') {
      const source = stripQuotes(cap.node.text)
      const resolvedPath = resolveImportSource(source, filepath, sourceRoot)
      if (resolvedPath) {
        const importedFileId = entityId('file', resolvedPath, resolvedPath)
        edges.push({
          type: 'imports',
          sourceId: fileId,
          targetId: importedFileId,
          meta: { symbol: '*' },
        })
      }
    }
  }

  // --- Extract call edges (intra-file resolution) ---
  const callCaptures = runQuery(tsLanguage, CALL_EXPRESSION_QUERY, rootNode)
  for (const cap of callCaptures) {
    if (cap.name === 'call.func_name' || cap.name === 'call.method_name') {
      const calleeName = cap.node.text
      const callNode = cap.name === 'call.func_name'
        ? cap.node.parent!  // call_expression
        : cap.node.parent!.parent! // member_expression → call_expression
      const line = callNode.startPosition.row + 1

      // Resolve callee to a known entity in this file
      const calleeId = resolveCallTarget(calleeName, filepath, entitySet)
      if (!calleeId) continue

      const callerId = findEnclosingEntity(cap.node, filepath, entitySet) ?? fileId
      edges.push({
        type: 'calls',
        sourceId: callerId,
        targetId: calleeId,
        meta: { siteLine: line },
      })
    }
  }

  // --- Extract extends edges ---
  const extendsCaptures = runQuery(tsLanguage, EXTENDS_CLAUSE_QUERY, rootNode)
  let extendsChild = ''
  for (const cap of extendsCaptures) {
    if (cap.name === 'extends.child') {
      extendsChild = cap.node.text
    } else if (cap.name === 'extends.parent') {
      const childId = classIds.get(extendsChild)
      const parentId = classIds.get(cap.node.text)
      if (childId && parentId) {
        edges.push({
          type: 'extends',
          sourceId: childId,
          targetId: parentId,
        })
      }
    }
  }

  // --- Extract implements edges ---
  const implCaptures = runQuery(tsLanguage, IMPLEMENTS_CLAUSE_QUERY, rootNode)
  let implClass = ''
  for (const cap of implCaptures) {
    if (cap.name === 'impl.class') {
      implClass = cap.node.text
    } else if (cap.name === 'impl.interface') {
      const classId = classIds.get(implClass)
      const ifaceId = entityId('interface', filepath, cap.node.text)
      if (classId && entitySet.has(ifaceId)) {
        edges.push({
          type: 'implements',
          sourceId: classId,
          targetId: ifaceId,
        })
      }
    }
  }

  return { filepath, entities, edges }
}

/**
 * Walk up from a node to find the nearest enclosing function/method/class entity.
 * Returns the entity ID if found, null otherwise.
 */
function findEnclosingEntity(
  node: Node,
  filepath: string,
  knownEntities: Set<string>
): string | null {
  let current = node.parent
  while (current) {
    if (current.type === 'method_definition') {
      const methodName = current.childForFieldName('name')?.text
      const classNode = current.parent?.parent // class_body → class_declaration
      const className = classNode?.childForFieldName('name')?.text
      if (className && methodName) {
        const id = entityId('method', filepath, `${className}.${methodName}`)
        if (knownEntities.has(id)) return id
      }
    }
    if (current.type === 'function_declaration') {
      const name = current.childForFieldName('name')?.text
      if (name) {
        const id = entityId('function', filepath, name)
        if (knownEntities.has(id)) return id
      }
    }
    if (current.type === 'class_declaration') {
      const name = current.childForFieldName('name')?.text
      if (name) {
        const id = entityId('class', filepath, name)
        if (knownEntities.has(id)) return id
      }
    }
    if (current.type === 'variable_declarator') {
      // Arrow function: const foo = () => {}
      const name = current.childForFieldName('name')?.text
      if (name) {
        const id = entityId('function', filepath, name)
        if (knownEntities.has(id)) return id
      }
    }
    current = current.parent
  }
  return null
}
