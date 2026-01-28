# AST-Node Merkle Tree + DAG Architecture

## Overview

A hybrid architecture that combines AST-node level merkle trees for change detection with an AST-node based directed acyclic graph (DAG) for dependency tracking. This enables semantic context management by parsing each file once and extracting two complementary data structures.

## The "Double Dipping" Architecture

```
Parse File Once (ts-morph)
         │
         ├──► Build AST-Node Merkle Tree (change detection)
         │       └── Hash each function/class/statement
         │
         └──► Build AST-Node DAG (dependency tracking)
                 └── Track "imports/calls" relationships
```

## Why This Works So Well

### 1. Single Parse = Zero Redundancy

```typescript
// One parse, two data structures
const ast = tsMorph.parseFile(sourceCode);

// Extract all AST nodes ONCE
const nodes = extractAllNodes(ast);  // functions, classes, vars, etc.

// Build merkle tree
nodes.forEach(node => {
  merkleTree.update(node.id, hash(node));
});

// Build DAG
nodes.forEach(node => {
  const deps = extractDependencies(node);  // what this node imports
  deps.forEach(dep => {
    dag.addEdge(node.id, dep.id);
  });
});
```

### 2. Perfect Correlation

**Merkle tree tells you:**
```
function calculateHash() changed
```

**DAG tells you:**
```
These functions depend on it:
  - processData()
  - validateInput()
  - renderOutput()
```

Together → **Complete context update!**

---

## Visual Example

### File: `src/utils/helper.ts`

```typescript
function calculateHash(input: string) {
  return SHA256(input);
}

function processData(data: string) {
  const hash = calculateHash(data);
  return hash.substring(0, 8);
}

function validateInput(input: string) {
  const hash = calculateHash(input);
  return hash === 'expected';
}
```

### After Parse:

**AST-Node Merkle Tree (for change detection):**
```
Root
├── calculateHash hash
├── processData hash
└── validateInput hash
```

**AST-Node DAG (for dependencies):**
```
calculateHash ←─ (no imports)
processData ───► calculateHash
validateInput ──► calculateHash
```

### After Change: Edit `calculateHash()`

**Merkle Tree detects:**
```
→ calculateHash hash changed
```

**DAG answers:**
```
→ Who needs context update?
  ✓ processData (imports calculateHash)
  ✓ validateInput (imports calculateHash)
```

---

## Implementation Pattern

```typescript
import { Project } from 'ts-morph';

class ASTContextManager {
  private merkleTree: IndexedMerkleTree;
  private dag: DependencyGraph;
  private nodeIndex: Map<string, string>;  // filename:line → nodeID
  private project: Project;

  constructor() {
    this.merkleTree = new IndexedMerkleTree();
    this.dag = new DependencyGraph();
    this.nodeIndex = new Map();
    this.project = new Project({
      useInMemoryFileSystem: true,
    });
  }

  // Parse once, build both structures
  processFile(filepath: string, content: string) {
    // Create source file in ts-morph project
    const sourceFile = this.project.createSourceFile(filepath, content);

    // Extract all AST nodes
    const nodes = this.extractNodes(sourceFile, filepath);

    // Update merkle tree (change detection)
    nodes.forEach(node => {
      const nodeID = `${filepath}:${node.line}`;
      this.nodeIndex.set(nodeID, node.id);
      this.merkleTree.update(node.id, this.hashNode(node));
    });

    // Update DAG (dependencies)
    nodes.forEach(node => {
      const deps = this.extractDependencies(node, sourceFile);
      deps.forEach(dep => {
        const depID = `${dep.filepath}:${dep.line}`;
        const depNodeId = this.nodeIndex.get(depID);
        if (depNodeId) {
          this.dag.addEdge(node.id, depNodeId);
        }
      });
    });
  }

  // Extract all semantic nodes from AST
  private extractNodes(sourceFile: SourceFile, filepath: string): Node[] {
    const nodes: Node[] = [];

    // Extract functions
    sourceFile.getFunctions().forEach(func => {
      nodes.push({
        id: `${filepath}:${func.getName()}:${func.getStartLineNumber()}`,
        name: func.getName(),
        type: 'function',
        filepath,
        line: func.getStartLineNumber(),
        code: func.getFullText(),
      });
    });

    // Extract classes
    sourceFile.getClasses().forEach(cls => {
      nodes.push({
        id: `${filepath}:${cls.getName()}:${cls.getStartLineNumber()}`,
        name: cls.getName(),
        type: 'class',
        filepath,
        line: cls.getStartLineNumber(),
        code: cls.getFullText(),
      });

      // Extract class methods
      cls.getMethods().forEach(method => {
        nodes.push({
          id: `${filepath}:${cls.getName()}.${method.getName()}:${method.getStartLineNumber()}`,
          name: `${cls.getName()}.${method.getName()}`,
          type: 'method',
          filepath,
          line: method.getStartLineNumber(),
          code: method.getFullText(),
        });
      });
    });

    // Extract variables (exports, const, let)
    sourceFile.getVariableStatements().forEach(stmt => {
      stmt.getDeclarations().forEach(decl => {
        const name = decl.getName();
        if (name) {
          nodes.push({
            id: `${filepath}:${name}:${decl.getStartLineNumber()}`,
            name,
            type: 'variable',
            filepath,
            line: decl.getStartLineNumber(),
            code: decl.getFullText(),
          });
        }
      });
    });

    return nodes;
  }

  // Extract dependencies from a node
  private extractDependencies(node: Node, sourceFile: SourceFile): NodeReference[] {
    const deps: NodeReference[] = [];

    // Find function calls
    const nodeText = node.code;
    const callRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    let match;

    while ((match = callRegex.exec(nodeText)) !== null) {
      const calledFunction = match[1];

      // Don't include the node itself
      if (calledFunction !== node.name) {
        // Find where this function is defined
        const foundFunc = sourceFile.getFunction(calledFunction);
        if (foundFunc) {
          deps.push({
            file: node.filepath,
            line: foundFunc.getStartLineNumber(),
          });
        }
      }
    }

    // Find import references
    const importDecls = sourceFile.getImportDeclarations();
    importDecls.forEach(imp => {
      const importNames = imp.getNamedImports().map(ni => ni.getName());
      importNames.forEach(name => {
        if (nodeText.includes(name)) {
          // This would need to resolve to the actual file/line
          // Simplified version here
          deps.push({
            file: imp.getModuleSpecifierValue(),
            line: 0, // Would need actual resolution
          });
        }
      });
    });

    return deps;
  }

  // Hash a node for merkle tree
  private hashNode(node: Node): string {
    const crypto = require('crypto');
    const content = `${node.type}:${node.name}:${node.code}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // On change detection
  handleChange(filepath: string, oldContent: string, newContent: string) {
    // 1. Detect what changed (merkle tree)
    const changedNodes = this.detectChanges(oldContent, newContent, filepath);
    // Returns: ['calculateHash']

    // 2. Find affected context (DAG)
    const affectedNodes = this.dag.getReverseDependencies(changedNodes);
    // Returns: ['processData', 'validateInput']

    // 3. Update context for all affected
    affectedNodes.forEach(nodeId => {
      this.updateNodeContext(nodeId);
    });

    return {
      changedNodes,
      affectedNodes,
    };
  }

  // Detect changes at AST-node level
  private detectChanges(
    old: string,
    new: string,
    filepath: string
  ): string[] {
    const oldAST = this.project.createSourceFile(`${filepath}.old`, old);
    const newAST = this.project.createSourceFile(`${filepath}.new`, new);

    const oldNodes = this.extractNodes(oldAST, filepath);
    const newNodes = this.extractNodes(newAST, filepath);

    const changed: string[] = [];

    // Compare by node name and hash
    oldNodes.forEach(oldNode => {
      const newNode = newNodes.find(n => n.name === oldNode.name);
      if (newNode && this.hashNode(oldNode) !== this.hashNode(newNode)) {
        changed.push(newNode.id);
      }
    });

    // Clean up temp files
    oldAST.delete();
    newAST.delete();

    return changed;
  }

  // Update context for a specific node
  private updateNodeContext(nodeId: string) {
    // Update embeddings, invalidate caches, etc.
    console.log(`Updating context for node: ${nodeId}`);
  }
}

// Node type
interface Node {
  id: string;
  name: string;
  type: 'function' | 'class' | 'method' | 'variable';
  filepath: string;
  line: number;
  code: string;
}

// Node reference for dependencies
interface NodeReference {
  file: string;
  line: number;
}
```

---

## Performance Benefits

| Without Double-Dip | With Double-Dip |
|-------------------|----------------|
| Parse file for merkle tree | ✅ Parse once |
| Parse file for DAG | ✅ Reuse AST |
| 2x parsing overhead | ✅ Zero redundancy |
| Inconsistent node IDs | ✅ Unified indexing |

---

## What You Get

**For every file change, you instantly know:**

1. **What changed?** (merkle tree)
   - `calculateHash()` body changed

2. **What's affected?** (DAG)
   - `processData()` needs recompilation
   - `validateInput()` needs recompilation

3. **What context to update?**
   - Update embeddings for changed node
   - Update embeddings for dependent nodes
   - Invalidate caches accordingly

---

## The Real Win: Semantic Understanding

This isn't just about performance - it's about **semantic correctness**.

### File-level change tracking:
```
helper.ts changed
→ Update context for helper.ts
→ But you don't know which parts matter
```

### AST-node level (double dip):
```
calculateHash() changed
→ Only update functions that call it
→ Skip functions that don't use it
→ Preserve irrelevant context
```

**This is HUGE for context management in AI systems** - you maintain **semantic relevance** instead of just updating everything.

---

## Granularity Comparison

| Granularity | Tree Size | Update Speed | Detects What? |
|------------|-----------|--------------|---------------|
| **File-level** | Small | Fast | File changed? |
| **Line-level** | Medium | Medium | Which lines changed? |
| **Block-level** | Medium | Medium | Which functions/blocks changed? |
| **AST-node level** | Large | Slower | Which semantic constructs changed? |

---

## Recommended Stack

```json
{
  "dependencies": {
    "ts-morph": "^20.0.0",                    // AST parsing & manipulation
    "@zk-kit/incremental-merkle-tree": "^1.1.0",  // Merkle tree with incremental updates
    "chokidar": "^3.5.3",                      // File watching
    "graph-data-structure": "^3.0.0"           // Or roll your own DAG
  }
}
```

### Key Libraries

#### 1. ts-morph
- **Purpose**: Fluent API wrapper around TypeScript Compiler API
- **Why**: Makes AST traversal and manipulation much easier
- **Install**: `npm install ts-morph`

#### 2. @zk-kit/incremental-merkle-tree
- **Purpose**: TypeScript incremental merkle tree
- **Why**: Built for dynamic updates, O(log n) operations
- **Install**: `npm install @zk-kit/incremental-merkle-tree`

#### 3. chokidar
- **Purpose**: Efficient cross-platform file watcher
- **Why**: Industry standard, minimal CPU usage
- **Install**: `npm install chokidar`

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    File System Watcher                       │
│                      (chokidar)                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ File Changed
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Single AST Parse                           │
│                      (ts-morph)                              │
└──────────┬───────────────────────────┬──────────────────────┘
           │                           │
           │                           │
           ▼                           ▼
┌──────────────────────┐    ┌──────────────────────┐
│  AST-Node Merkle     │    │  AST-Node DAG        │
│  Tree                │    │  (Dependency Graph)  │
│                      │    │                      │
│  - Change Detection  │    │  - Call Graph        │
│  - O(log n) updates  │    │  - Import Tracking   │
│  - Hash per node     │    │  - Semantic deps     │
└──────────┬───────────┘    └──────────┬───────────┘
           │                          │
           │ Changed Node IDs         │
           │                          │
           ▼                          ▼
           └────────────┬────────────┘
                        │
                        ▼
           ┌──────────────────────────┐
           │  Context Update Engine    │
           │                          │
           │  - Update embeddings     │
           │  - Invalidate caches     │
           │  - Rebuild LLM context   │
           └──────────────────────────┘
```

---

## Use Cases

### 1. AI Code Assistant Context Management
- Track which functions changed
- Update only relevant context for LLM
- Maintain semantic coherence

### 2. Incremental Compilation
- Detect changed functions/classes
- Rebuild only affected modules
- Optimize build times

### 3. Code Review Automation
- Highlight semantic changes
- Show impact across codebase
- Track dependency chains

### 4. Documentation Generation
- Update docs for changed nodes
- Find all usages of modified code
- Maintain accurate references

---

## Implementation Notes

### 1. Node ID Convention
Use a consistent format: `{filepath}:{nodeName}:{lineNumber}`

Example:
```
src/utils/helper.ts:calculateHash:5
src/utils/helper.ts:processData:9
```

### 2. Hash Function
Hash multiple attributes to detect semantic changes:

```typescript
const content = `${type}:${name}:${code}`;
const hash = sha256(content);
```

### 3. DAG Storage Options
- **In-memory**: Fastest, requires rebuild on restart
- **Graph database** (Neo4j): Persisted, supports complex queries
- **Custom serialization**: Balance between speed and persistence

### 4. Incremental Updates
On file change:
1. Parse new file
2. Identify new/modified/deleted nodes
3. Update merkle tree (only affected paths)
4. Update DAG (add/remove edges)
5. Propagate changes to dependent nodes

---

## Future Enhancements

1. **Cross-file dependencies**: Track imports across files
2. **Type information**: Include type signatures in hashes
3. **Configuration**: Control granularity (function/statement level)
4. **Caching**: Cache AST nodes between runs
5. **Parallel processing**: Process multiple files concurrently
6. **Visualization**: Render dependency graphs for debugging
