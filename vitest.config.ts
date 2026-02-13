import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const pkg = (rel: string) => resolve(__dirname, rel);

const packages: Record<string, string> = {
  'orchestrator': 'packages/core/orchestrator/src',
  'agent':        'packages/core/agent/src',
  'tools':        'packages/core/tools/src',
  'llm':          'packages/core/llm/src',
  'context':      'packages/core/context/src',
  'shared':       'packages/core/shared/src',
  'work':         'packages/core/work/src',
  'types':        'packages/core/types/src',
  'protocol':     'packages/core/protocol/src',
  'comms-bus':    'packages/infra/comms-bus/src',
  'harness-daemon': 'packages/infra/harness-daemon/src',
  'harness-client': 'packages/infra/harness-client/src',
  'graphd':       'packages/infra/graphd/src',
  'agent-memory': 'packages/plugins/agent-memory/src',
  'semantic-compiler': 'packages/plugins/semantic-compiler/src',
  'memory-injector':   'packages/plugins/memory-injector/src',
  'entity-graph':      'packages/plugins/entity-graph/src',
  'control-plane':     'packages/apps/control-plane/src',
  'tui':               'packages/apps/tui',
  'dashboard-control': 'packages/apps/dashboard-control/src',
};

// Array form: string find uses @rollup/plugin-alias prefix matching
// (matches exact OR find + '/' prefix). Maps to directories so both
// bare imports (resolves index.ts) and subpath imports work.
const alias: Array<{ find: string | RegExp; replacement: string }> = Object.entries(packages).map(
  ([name, dir]) => ({ find: name, replacement: pkg(dir) })
);

// dashboard-control uses @/ alias internally — regex avoids matching @scope packages
// resolve() strips trailing slash, so append it to preserve the path separator
alias.push({ find: /^@\//, replacement: pkg('packages/apps/dashboard-control/src') + '/' });
// agent-memory scripts (non-src tests)
alias.push({ find: 'agent-memory-scripts', replacement: pkg('packages/plugins/agent-memory/scripts') });

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    testTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/dashboard/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'dashboard',
          include: ['tests/dashboard/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['tests/_utils/dashboard/setup.ts'],
        },
      },
    ],
  },
  resolve: { alias },
});
