import { describe, expect, it } from 'vitest'
import { assignModuleConcerns, labelsForModuleConcerns } from './module-assignment.js'

describe('module concern assignment', () => {
  it('maps files into deterministic module concerns', () => {
    const assignment = assignModuleConcerns([
      'packages/agent-memory/src/index.ts',
      'packages/agent-memory/src/architecture/index.ts',
      'packages/dashboard-control/src/main.tsx',
      'services/api/src/server.ts',
      'src/shared/util.ts',
      'tests/unit/foo.test.ts',
      'scripts/setup.py',
    ])

    expect(assignment.byFile.get('packages/agent-memory/src/index.ts')).toBe('module:packages/agent-memory')
    expect(assignment.byFile.get('packages/dashboard-control/src/main.tsx')).toBe('module:packages/dashboard-control')
    expect(assignment.byFile.get('services/api/src/server.ts')).toBe('module:services/api')
    expect(assignment.byFile.get('src/shared/util.ts')).toBe('module:src/shared')
    expect(assignment.byFile.get('tests/unit/foo.test.ts')).toBe('module:tests/unit')
    expect(assignment.byFile.get('scripts/setup.py')).toBe('module:scripts')

    expect(assignment.concernFiles.get('module:packages/agent-memory')?.size).toBe(2)
  })

  it('derives stable labels from module concern ids', () => {
    const assignment = assignModuleConcerns([
      'packages/agent-memory/src/index.ts',
      'scripts/setup.py',
    ])
    const labels = labelsForModuleConcerns(assignment)

    expect(labels.get('module:packages/agent-memory')).toBe('packages/agent-memory')
    expect(labels.get('module:scripts')).toBe('scripts')
  })
})
