/**
 * Smoke test: Verify all critical imports resolve without error.
 * Exit 0 = pass, Exit 1 = fail
 */

async function main(): Promise<void> {
  const failures: string[] = [];

  // Test agent-core imports
  try {
    const agentCore = await import('../../packages/agent-core/src/index.js');
    if (!agentCore.Agent) throw new Error('Agent class not exported');
    if (!agentCore.ToolRegistry) throw new Error('ToolRegistry class not exported');
    if (!agentCore.ContextWindow) throw new Error('ContextWindow class not exported');
    if (!agentCore.createAdapter) throw new Error('createAdapter not exported');
    console.log('[PASS] agent-core imports');
  } catch (error) {
    console.error('[FAIL] agent-core imports:', error);
    failures.push('agent-core');
  }

  // Test graphd imports
  try {
    const graphd = await import('../../packages/graphd/src/index.js');
    if (!graphd.GraphStore) throw new Error('GraphStore class not exported');
    console.log('[PASS] graphd imports');
  } catch (error) {
    console.error('[FAIL] graphd imports:', error);
    failures.push('graphd');
  }

  // Test kernel imports
  try {
    const loop = await import('../loop.js');
    if (!loop.runIteration) throw new Error('runIteration not exported');
    console.log('[PASS] kernel loop imports');
  } catch (error) {
    console.error('[FAIL] kernel loop imports:', error);
    failures.push('kernel-loop');
  }

  // Test benchmark imports
  try {
    const benchmark = await import('../benchmark.js');
    if (!benchmark.BenchmarkRunner) throw new Error('BenchmarkRunner not exported');
    console.log('[PASS] benchmark imports');
  } catch (error) {
    console.error('[FAIL] benchmark imports:', error);
    failures.push('benchmark');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} import(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log('\nAll imports successful');
  process.exit(0);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
