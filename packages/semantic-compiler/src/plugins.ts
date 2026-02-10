import type {
  CompilerQuestion,
  InvariantInput,
  RefinedInvariant,
  SystemSurface,
  VerificationPlan,
} from './types.js';

export interface StrategySelectionInput {
  invariant: InvariantInput;
  system_surface: SystemSurface;
  repo_metadata?: Record<string, unknown>;
}

export interface StrategySupport {
  score: number;
  reason: string;
}

export interface StrategyCompileInput {
  inv_id: string;
  original_text: string;
  system_surface: SystemSurface;
  repo_metadata?: Record<string, unknown>;
}

export interface StrategyCompileOutput {
  refined: RefinedInvariant;
  assumptions: string[];
  verification_plan: VerificationPlan;
  verdict_rule: string;
  questions?: CompilerQuestion[];
}

export interface VerificationStrategyPlugin {
  id: string;
  description: string;
  supports(input: StrategySelectionInput): StrategySupport;
  compile(input: StrategyCompileInput): StrategyCompileOutput;
}

function includesAny(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function buildScope(surface: SystemSurface, terms: string[]): string[] {
  const hits = new Set<string>();
  const combined = [
    ...surface.services,
    ...surface.storage,
    ...surface.ui_surfaces,
    ...surface.external_dependencies,
    ...surface.main_flows,
  ];

  for (const part of combined) {
    const normalized = part.toLowerCase();
    if (terms.some((term) => normalized.includes(term))) {
      hits.add(part);
    }
  }

  if (hits.size === 0) {
    for (const term of terms.slice(0, 4)) hits.add(term);
  }

  return Array.from(hits);
}

const restartPersistenceStrategy: VerificationStrategyPlugin = {
  id: 'restart_persistence',
  description: 'Process restart scenario with state persistence assertions',
  supports(input) {
    const score = includesAny(input.invariant.text, ['restart', 'reboot', 'persist', 'remain signed in', 'survive']) ? 0.95 : 0;
    return {
      score,
      reason: score > 0 ? 'Invariant references restart/persistence semantics' : 'No restart/persistence language',
    };
  },
  compile(input) {
    const text = input.original_text;
    const scope = buildScope(input.system_surface, ['auth', 'session', 'startup', 'oauth', 'restart']);
    return {
      refined: {
        intent: 'State survives process restart with no forced re-authentication',
        scope,
        operational_definition: [
          'A user completes auth and reaches authenticated state',
          'Application process is terminated and restarted under deterministic harness state',
          'Authenticated state is restored without interactive re-login',
        ],
      },
      assumptions: [
        'OAuth provider is deterministic in CI',
        'Session store is persisted across app restart in harness',
      ],
      verification_plan: {
        strategy_id: 'restart_persistence',
        steps: [
          { kind: 'harness_setup', spec: 'docker compose up: app, db, oauth_stub' },
          { kind: 'action', spec: 'playwright: login_with_google(user=A)' },
          { kind: 'assert', spec: 'expect(auth_state==SIGNED_IN)' },
          { kind: 'action', spec: 'restart(app)' },
          { kind: 'assert', spec: 'expect(auth_state==SIGNED_IN)' },
        ],
        evidence: [
          'playwright video',
          'trace log',
          'db snapshot diff (session table)',
          'app logs around restore',
        ],
      },
      verdict_rule: 'all asserts pass',
    };
  },
};

const uiScenarioStrategy: VerificationStrategyPlugin = {
  id: 'ui_scenario',
  description: 'UI scenario validation with Playwright actions and assertions',
  supports(input) {
    const score = includesAny(input.invariant.text, ['ui', 'click', 'screen', 'onboarding', 'button', 'login']) ? 0.8 : 0;
    return {
      score,
      reason: score > 0 ? 'Invariant references UI interactions' : 'No UI language detected',
    };
  },
  compile(input) {
    const scope = buildScope(input.system_surface, ['ui', 'web', 'frontend', 'onboarding']);
    return {
      refined: {
        intent: 'UI behavior is stable and measurable for the defined scenario',
        scope,
        operational_definition: [
          'Scenario starts from a deterministic fixture state',
          'User-visible actions are replayed through Playwright script steps',
          'Expected selectors/events are asserted at each checkpoint',
        ],
      },
      assumptions: [
        'DOM selectors used by tests are stable',
        'Frontend timing is controlled by deterministic waits/assertions',
      ],
      verification_plan: {
        strategy_id: 'ui_scenario',
        steps: [
          { kind: 'harness_setup', spec: 'playwright bootstrap with deterministic fixtures' },
          { kind: 'action', spec: 'playwright: execute scripted UI scenario from start state' },
          { kind: 'assert', spec: 'expect required UI checkpoints and event counters to match operational definition' },
        ],
        evidence: ['playwright trace', 'screenshots', 'structured ui event log'],
      },
      verdict_rule: 'all asserts pass',
    };
  },
};

const apiScenarioStrategy: VerificationStrategyPlugin = {
  id: 'api_scenario',
  description: 'HTTP/API scenario verification with explicit response assertions',
  supports(input) {
    const score = includesAny(input.invariant.text, ['api', 'endpoint', 'http', 'response', '/']) ? 0.7 : 0;
    return {
      score,
      reason: score > 0 ? 'Invariant references API behavior' : 'No API language detected',
    };
  },
  compile(input) {
    const scope = buildScope(input.system_surface, ['api', 'service', 'http', 'backend']);
    return {
      refined: {
        intent: 'HTTP surface satisfies expected semantics for the scenario',
        scope,
        operational_definition: [
          'Request preconditions are explicitly seeded',
          'API call is issued with deterministic payload and headers',
          'Status code and response body assertions are checked',
        ],
      },
      assumptions: [
        'API dependencies can be stubbed or seeded deterministically',
      ],
      verification_plan: {
        strategy_id: 'api_scenario',
        steps: [
          { kind: 'harness_setup', spec: 'seed API fixtures and start service dependencies' },
          { kind: 'action', spec: 'http client executes scenario request(s)' },
          { kind: 'assert', spec: 'assert status/body schema/contract expectations' },
        ],
        evidence: ['http request-response log', 'service logs', 'snapshot diff (if stateful)'],
      },
      verdict_rule: 'all asserts pass',
    };
  },
};

const traceInvariantStrategy: VerificationStrategyPlugin = {
  id: 'trace_checker',
  description: 'Trace invariant checker over event stream semantics',
  supports(input) {
    const score = includesAny(input.invariant.text, ['never', 'always', 'trace', 'event', 'unhandled']) ? 0.75 : 0;
    return {
      score,
      reason: score > 0 ? 'Invariant is best expressed as event stream constraints' : 'No trace-invariant language detected',
    };
  },
  compile(input) {
    const scope = buildScope(input.system_surface, ['trace', 'event', 'runtime', 'workflow']);
    return {
      refined: {
        intent: 'Runtime event stream satisfies declared invariant properties',
        scope,
        operational_definition: [
          'A canonical trace.jsonl event stream is captured for the scenario',
          'Invariant predicates are evaluated over ordered events',
          'Any counterexample event sequence is persisted as failure evidence',
        ],
      },
      assumptions: [
        'Event vocabulary is normalized across environments',
      ],
      verification_plan: {
        strategy_id: 'trace_checker',
        steps: [
          { kind: 'harness_setup', spec: 'enable structured trace sink and deterministic seed' },
          { kind: 'action', spec: 'run scenario that should satisfy invariant' },
          { kind: 'trace_check', spec: 'evaluate trace invariant predicate over trace.jsonl' },
        ],
        evidence: ['trace.jsonl', 'predicate evaluation report', 'counterexample snippet on failure'],
      },
      verdict_rule: 'trace predicate passes',
    };
  },
};

export const DEFAULT_STRATEGY_PLUGINS: VerificationStrategyPlugin[] = [
  restartPersistenceStrategy,
  uiScenarioStrategy,
  apiScenarioStrategy,
  traceInvariantStrategy,
];

export function selectBestStrategy(
  input: StrategySelectionInput,
  plugins: VerificationStrategyPlugin[] = DEFAULT_STRATEGY_PLUGINS
): { plugin: VerificationStrategyPlugin | null; support: StrategySupport } {
  let winner: VerificationStrategyPlugin | null = null;
  let best: StrategySupport = { score: 0, reason: 'No strategy matched' };

  for (const plugin of plugins) {
    const support = plugin.supports(input);
    if (support.score > best.score) {
      best = support;
      winner = plugin;
    }
  }

  return { plugin: winner, support: best };
}
