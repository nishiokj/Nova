import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  MutationEvaluationResult,
  MutationPatchOperation,
  MutationProposalInput,
} from './types.js'

export type RunCommandInput = {
  cwd: string
  args: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  command?: string
  rejectOnNonZero?: boolean
}

export type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type MutationEventRecorder = (eventType: string, payload: unknown) => Promise<void>

const TEST_FAILURE_INVALID_RE = /syntaxerror|transform failed|build failed|compilation failed|unexpected token|no test files found|no tests found/i
const ALLOWED_PARENT_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'COMSPEC',
  'TERM',
  'SHELL',
  'PWD',
] as const

export function pickParentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_PARENT_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
  return env
}

export function summarizeOutput(output: string): string | undefined {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed
}

export function normalizeContentSignal(content: string): string {
  return content.replace(/\s+/g, '')
}

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  const command = input.command ?? 'git'
  return new Promise((resolve, reject) => {
    const child = spawn(command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Command timed out after ${input.timeoutMs}ms: ${command} ${input.args.join(' ')}`))
    }, input.timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', code => {
      clearTimeout(timer)
      const exitCode = code ?? 1
      const result = { stdout, stderr, exitCode }
      if (exitCode !== 0 && input.rejectOnNonZero !== false) {
        reject(new Error(`Command failed (${exitCode}): ${command} ${input.args.join(' ')}\n${stderr}`))
        return
      }
      resolve(result)
    })
  })
}

export async function applyMutationPatch(
  sourceRoot: string,
  operations: MutationPatchOperation[],
): Promise<{ patchApplied: boolean; realMutation: boolean; reason: string }> {
  for (const operation of operations) {
    if (operation.op !== 'replace') {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Unsupported patch operation: ${String((operation as { op?: string }).op ?? 'unknown')}`,
      }
    }

    const targetPath = path.resolve(sourceRoot, operation.file)
    const rootPath = path.resolve(sourceRoot)
    if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Patch target escapes repo root: ${operation.file}`,
      }
    }

    const before = await readFile(targetPath, 'utf-8').catch(() => null)
    if (before === null) {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Patch target does not exist: ${operation.file}`,
      }
    }

    if (!operation.find) {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Patch operation for ${operation.file} is missing a non-empty find string`,
      }
    }

    const matches = before.split(operation.find).length - 1
    const expectedMatches = operation.expectedMatches ?? 1
    if (matches !== expectedMatches) {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Expected ${expectedMatches} exact matches for ${operation.file}, found ${matches}`,
      }
    }

    const after = before.replace(operation.find, operation.replace)
    if (after === before) {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Patch for ${operation.file} did not change file contents`,
      }
    }

    const realMutation = normalizeContentSignal(after) !== normalizeContentSignal(before)
    if (!realMutation) {
      return {
        patchApplied: false,
        realMutation: false,
        reason: `Patch for ${operation.file} only changed formatting or whitespace`,
      }
    }

    await writeFile(targetPath, after, 'utf-8')
  }

  return {
    patchApplied: true,
    realMutation: true,
    reason: 'Patch applied',
  }
}

export async function evaluateMutation(input: {
  sourceRoot: string
  proposal: MutationProposalInput
  proposalArtifactId: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  recordEvent?: MutationEventRecorder
}): Promise<MutationEvaluationResult> {
  const { sourceRoot, proposal, proposalArtifactId, env, timeoutMs } = input
  const recordEvent = input.recordEvent ?? (async () => {})
  const commandLabel = proposal.testTarget.command.join(' ')
  const evaluationStartedAt = Date.now()
  await recordEvent('mutation.evaluation.started', {
    proposalArtifactId,
    targetFile: proposal.targetFile,
    targetSymbol: proposal.targetSymbol,
    command: proposal.testTarget.command,
  })

  const baselineStartedAt = Date.now()
  await recordEvent('mutation.baseline.started', {
    proposalArtifactId,
    command: proposal.testTarget.command,
  })
  const baseline = await runCommand({
    cwd: sourceRoot,
    command: proposal.testTarget.command[0],
    args: proposal.testTarget.command.slice(1),
    env,
    timeoutMs,
    rejectOnNonZero: false,
  })
  await recordEvent('mutation.baseline.finished', {
    proposalArtifactId,
    exitCode: baseline.exitCode,
    durationMs: Date.now() - baselineStartedAt,
  })

  if (baseline.exitCode !== 0) {
    await recordEvent('mutation.result', {
      proposalArtifactId,
      status: 'invalid',
      stage: 'baseline',
      durationMs: Date.now() - evaluationStartedAt,
    })
    return {
      id: proposalArtifactId,
      status: 'invalid',
      realMutation: false,
      preservesIntendedBehavior: null,
      patchApplied: false,
      workspacePath: sourceRoot,
      testTarget: proposal.testTarget,
      testsRun: [commandLabel],
      summary: 'Baseline target does not pass before mutation',
      reason: 'The named test target failed before the mutation was applied.',
      stdoutSummary: summarizeOutput(baseline.stdout),
      stderrSummary: summarizeOutput(baseline.stderr),
    }
  }

  await recordEvent('mutation.patch.started', {
    proposalArtifactId,
    operationCount: proposal.patch.length,
  })
  const patchResult = await applyMutationPatch(sourceRoot, proposal.patch)
  if (!patchResult.patchApplied || !patchResult.realMutation) {
    await recordEvent('mutation.patch.rejected', {
      proposalArtifactId,
      patchApplied: patchResult.patchApplied,
      realMutation: patchResult.realMutation,
      reason: patchResult.reason,
    })
    await recordEvent('mutation.result', {
      proposalArtifactId,
      status: 'invalid',
      stage: 'patch',
      durationMs: Date.now() - evaluationStartedAt,
    })
    return {
      id: proposalArtifactId,
      status: 'invalid',
      realMutation: patchResult.realMutation,
      preservesIntendedBehavior: null,
      patchApplied: patchResult.patchApplied,
      workspacePath: sourceRoot,
      testTarget: proposal.testTarget,
      testsRun: [commandLabel],
      summary: 'Mutation proposal did not apply as a real code change',
      reason: patchResult.reason,
    }
  }
  await recordEvent('mutation.patch.applied', {
    proposalArtifactId,
    operationCount: proposal.patch.length,
  })

  const mutatedStartedAt = Date.now()
  await recordEvent('mutation.test.started', {
    proposalArtifactId,
    command: proposal.testTarget.command,
  })
  const mutated = await runCommand({
    cwd: sourceRoot,
    command: proposal.testTarget.command[0],
    args: proposal.testTarget.command.slice(1),
    env,
    timeoutMs,
    rejectOnNonZero: false,
  })
  await recordEvent('mutation.test.finished', {
    proposalArtifactId,
    exitCode: mutated.exitCode,
    durationMs: Date.now() - mutatedStartedAt,
  })

  if (mutated.exitCode === 0) {
    await recordEvent('mutation.result', {
      proposalArtifactId,
      status: 'survived',
      stage: 'mutated-test',
      durationMs: Date.now() - evaluationStartedAt,
    })
    return {
      id: proposalArtifactId,
      status: 'survived',
      realMutation: true,
      preservesIntendedBehavior: null,
      patchApplied: true,
      workspacePath: sourceRoot,
      testTarget: proposal.testTarget,
      testsRun: [commandLabel],
      summary: 'Mutation survived the named test target',
      reason: 'The named test target still passed after applying the mutation.',
      stdoutSummary: summarizeOutput(mutated.stdout),
      stderrSummary: summarizeOutput(mutated.stderr),
    }
  }

  const output = `${mutated.stdout}\n${mutated.stderr}`
  if (TEST_FAILURE_INVALID_RE.test(output)) {
    await recordEvent('mutation.result', {
      proposalArtifactId,
      status: 'invalid',
      stage: 'mutated-test',
      durationMs: Date.now() - evaluationStartedAt,
    })
    return {
      id: proposalArtifactId,
      status: 'invalid',
      realMutation: true,
      preservesIntendedBehavior: null,
      patchApplied: true,
      workspacePath: sourceRoot,
      testTarget: proposal.testTarget,
      testsRun: [commandLabel],
      summary: 'Mutation caused setup/build failure instead of an observed behavioral failure',
      reason: 'The named target failed before the tests could cleanly evaluate the mutation.',
      stdoutSummary: summarizeOutput(mutated.stdout),
      stderrSummary: summarizeOutput(mutated.stderr),
    }
  }

  await recordEvent('mutation.result', {
    proposalArtifactId,
    status: 'killed',
    stage: 'mutated-test',
    durationMs: Date.now() - evaluationStartedAt,
  })
  return {
    id: proposalArtifactId,
    status: 'killed',
    realMutation: true,
    preservesIntendedBehavior: null,
    patchApplied: true,
    workspacePath: sourceRoot,
    testTarget: proposal.testTarget,
    testsRun: [commandLabel],
    summary: 'Mutation was killed by the named test target',
    reason: 'The named test target failed after the mutation was applied.',
    stdoutSummary: summarizeOutput(mutated.stdout),
    stderrSummary: summarizeOutput(mutated.stderr),
  }
}
