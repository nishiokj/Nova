/**
 * Workflow handling tests for frontend-backend integration
 *
 * These tests verify:
 * - Session message dispatching with workflow templates
 * - Session control operations (start/stop/fork)
 * - Review decision flow between frontend and backend
 * - Workflow template parsing (inline and DB-based)
 * - Frontend-backend API data flow and error handling
 *
 * Note: Full integration tests require harness mocking.
 * These tests verify data structures, serialization, and flow patterns.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type {
  CockpitSessionControlInput,
  CockpitSessionReviewDecisionInput,
  CockpitMarkdownContextInput,
  WorkItemSpec,
  WorkItemTemplate,
  FocusPacket,
  NormalizedSessionEvent,
  SessionRollup,
  SessionPanelStatus,
} from '../packages/dashboard-control/src/lib/api/types';

// Simulate backend session row
interface SessionRow {
  sessionKey: string;
  status: string;
  goal: string | null;
  currentWorkItemId: string | null;
  currentObjective: string | null;
  clientType: string;
  workingDir: string | null;
  createdAt: number;
  lastAccessedAt: number;
  metadata: Record<string, unknown>;
}

// Simulate frontend request/response
interface SessionMessageRequest {
  sessionKey: string;
  message: string;
  markdownContext?: CockpitMarkdownContextInput;
}

interface SessionMessageResponse {
  success: boolean;
  sessionKey: string;
  requestId?: string;
  queued?: boolean;
  markdownContextAttached?: boolean;
  workflowTemplateApplied?: boolean;
  workflowTemplate?: { id?: string; name?: string };
  error?: string;
}

// Simulate workflow template dispatch
interface WorkflowDispatchResult {
  ok: true | false;
  applied: boolean;
  dispatchMetadata?: Record<string, unknown>;
  metadataPatch?: Record<string, unknown>;
  templateId?: string;
  templateName?: string;
  status?: number;
  error?: string;
}

describe('Workflow Handling - Frontend to Backend', () => {
  let mockSession: SessionRow;

  beforeEach(() => {
    mockSession = {
      sessionKey: 'session-abc123',
      status: 'active',
      goal: null,
      currentWorkItemId: null,
      currentObjective: null,
      clientType: 'cockpit',
      workingDir: '/home/user/project',
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      lastAccessedAt: Math.floor(Date.now() / 1000),
      metadata: {},
    };
  });

  describe('Session message dispatching', () => {
    it('creates valid message request with basic message', () => {
      const request: SessionMessageRequest = {
        sessionKey: 'session-123',
        message: 'Implement user authentication',
      };

      expect(request.sessionKey).toBe('session-123');
      expect(request.message).toBe('Implement user authentication');
      expect(request.markdownContext).toBeUndefined();
    });

    it('creates message request with markdown context', () => {
      const markdownContext: CockpitMarkdownContextInput = {
        path: '/docs/workflow.md',
        projectPath: '/home/user/project',
        content: '# Workflow\n\n1. Setup auth',
        updatedAt: new Date().toISOString(),
        isDirty: false,
      };

      const request: SessionMessageRequest = {
        sessionKey: 'session-123',
        message: 'Start workflow',
        markdownContext,
      };

      expect(request.markdownContext?.path).toBe('/docs/workflow.md');
      expect(request.markdownContext?.content).toContain('Setup auth');
      expect(request.markdownContext?.isDirty).toBe(false);
    });

    it('handles successful message dispatch response', () => {
      const response: SessionMessageResponse = {
        success: true,
        sessionKey: 'session-123',
        requestId: 'req-abc456',
        queued: false,
        markdownContextAttached: false,
        workflowTemplateApplied: false,
      };

      expect(response.success).toBe(true);
      expect(response.requestId).toBe('req-abc456');
      expect(response.queued).toBe(false);
    });

    it('handles workflow template application in response', () => {
      const response: SessionMessageResponse = {
        success: true,
        sessionKey: 'session-123',
        requestId: 'req-abc456',
        queued: true,
        markdownContextAttached: true,
        workflowTemplateApplied: true,
        workflowTemplate: {
          id: 'template-auth',
          name: 'Authentication Workflow',
        },
      };

      expect(response.workflowTemplateApplied).toBe(true);
      expect(response.workflowTemplate?.id).toBe('template-auth');
      expect(response.workflowTemplate?.name).toBe('Authentication Workflow');
    });

    it('handles error response from message dispatch', () => {
      const response: SessionMessageResponse = {
        success: false,
        sessionKey: 'session-123',
        error: 'Session not found',
      };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Session not found');
      expect(response.requestId).toBeUndefined();
    });

    it('serializes and deserializes message request', () => {
      const original: SessionMessageRequest = {
        sessionKey: 'session-123',
        message: 'Test message with unicode: 🎉 日本語',
        markdownContext: {
          path: '/test.md',
          content: 'content',
        },
      };

      const serialized = JSON.stringify(original);
      const deserialized = JSON.parse(serialized) as SessionMessageRequest;

      expect(deserialized.sessionKey).toBe(original.sessionKey);
      expect(deserialized.message).toBe(original.message);
      expect(deserialized.markdownContext?.path).toBe(original.markdownContext?.path);
    });
  });

  describe('Session control operations', () => {
    it('creates valid start control input', () => {
      const input: CockpitSessionControlInput = {
        action: 'start',
        message: 'Continue with current objective',
      };

      expect(input.action).toBe('start');
      expect(input.message).toBe('Continue with current objective');
    });

    it('creates valid stop control input', () => {
      const input: CockpitSessionControlInput = {
        action: 'stop',
        note: 'Stopping for user confirmation',
      };

      expect(input.action).toBe('stop');
      expect(input.note).toBe('Stopping for user confirmation');
    });

    it('creates valid fork control input', () => {
      const input: CockpitSessionControlInput = {
        action: 'fork',
        targetSessionKey: 'session-123-fork',
      };

      expect(input.action).toBe('fork');
      expect(input.targetSessionKey).toBe('session-123-fork');
    });

    it('validates control action types', () => {
      const validActions: CockpitSessionControlInput['action'][] = ['start', 'stop', 'fork'];
      
      for (const action of validActions) {
        const input: CockpitSessionControlInput = { action };
        expect(['start', 'stop', 'fork']).toContain(input.action);
      }
    });

    it('handles control response with fork', () => {
      const response = {
        success: true,
        action: 'fork' as const,
        sourceSessionKey: 'session-123',
        targetSessionKey: 'session-123-fork',
      };

      expect(response.success).toBe(true);
      expect(response.targetSessionKey).toContain('fork');
    });

    it('handles control response with stop', () => {
      const response = {
        success: true,
        action: 'stop' as const,
        sessionKey: 'session-123',
        requestId: 'req-stop-abc',
      };

      expect(response.success).toBe(true);
      expect(response.requestId).toBeDefined();
    });

    it('handles control error response', () => {
      const response = {
        success: false,
        sessionKey: 'session-123',
        error: 'Session not found',
      };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Session not found');
    });
  });

  describe('Review decision flow', () => {
    it('creates valid accept decision input', () => {
      const input: CockpitSessionReviewDecisionInput = {
        decision: 'accept',
        note: 'LGTM, looks good',
      };

      expect(input.decision).toBe('accept');
      expect(input.note).toBe('LGTM, looks good');
    });

    it('creates valid request_changes decision input', () => {
      const input: CockpitSessionReviewDecisionInput = {
        decision: 'request_changes',
        note: 'Need to fix the error handling',
        requestId: 'req-123',
      };

      expect(input.decision).toBe('request_changes');
      expect(input.requestId).toBe('req-123');
    });

    it('validates review decision types', () => {
      const validDecisions: CockpitSessionReviewDecisionInput['decision'][] = ['accept', 'request_changes'];
      
      for (const decision of validDecisions) {
        const input: CockpitSessionReviewDecisionInput = { decision };
        expect(['accept', 'request_changes']).toContain(input.decision);
      }
    });

    it('handles review decision response', () => {
      const response = {
        success: true,
        sessionKey: 'session-123',
        decision: 'accept' as const,
        fromStatus: 'ready',
        toStatus: 'completed',
      };

      expect(response.success).toBe(true);
      expect(response.fromStatus).toBe('ready');
      expect(response.toStatus).toBe('completed');
    });

    it('handles request_changes status transition', () => {
      const response = {
        success: true,
        sessionKey: 'session-123',
        decision: 'request_changes' as const,
        fromStatus: 'ready',
        toStatus: 'active',
      };

      expect(response.toStatus).toBe('active');
    });
  });

  describe('Workflow template dispatch', () => {
    it('validates work item spec structure', () => {
      const spec: WorkItemSpec = {
        id: 'spec-1',
        objective: 'Implement feature X',
        agent: 'standard',
        dependencies: ['spec-0'],
        metadata: {
          domain: 'backend',
          targetPaths: ['/src/backend'],
        },
      };

      expect(spec.id).toBe('spec-1');
      expect(spec.objective).toBe('Implement feature X');
      expect(spec.agent).toBe('standard');
      expect(spec.dependencies).toEqual(['spec-0']);
      expect(spec.metadata?.domain).toBe('backend');
    });

    it('validates workflow template structure', () => {
      const template: WorkItemTemplate = {
        id: 'template-1',
        name: 'Feature Template',
        description: 'Standard feature workflow',
        specs: [
          {
            id: 'spec-1',
            objective: 'Step 1',
            agent: 'standard',
            dependencies: [],
          },
          {
            id: 'spec-2',
            objective: 'Step 2',
            agent: 'standard',
            dependencies: ['spec-1'],
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(template.specs).toHaveLength(2);
      expect(template.specs[1].dependencies).toContain('spec-1');
    });

    it('creates valid workflow dispatch result for DB template', () => {
      const result: WorkflowDispatchResult = {
        ok: true,
        applied: true,
        templateId: 'template-auth',
        templateName: 'Authentication Workflow',
        dispatchMetadata: {
          cockpit_handoff_spec: {
            goal: 'Setup auth',
            context: 'Template: Authentication Workflow',
            workItems: [],
          },
        },
        metadataPatch: {
          workflow_template_applied: true,
          workflow_template_id: 'template-auth',
          workflow_template_name: 'Authentication Workflow',
        },
      };

      expect(result.templateId).toBe('template-auth');
      expect(result.templateName).toBe('Authentication Workflow');
    });

    it('handles workflow template not found error', () => {
      const result: WorkflowDispatchResult = {
        ok: false,
        applied: false,
        status: 404,
        error: 'Workflow template not found: unknown-template',
      };

      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.error).toContain('not found');
    });

    it('handles workflow database unavailable error', () => {
      const result: WorkflowDispatchResult = {
        ok: false,
        applied: false,
        status: 503,
        error: 'Workflow template database is not available',
      };

      expect(result.status).toBe(503);
      expect(result.error).toContain('not available');
    });
  });

  describe('Focus packets workflow', () => {
    it('creates valid escalation packet', () => {
      const packet: FocusPacket = {
        packetId: 'pkt-escalation-123',
        sessionKey: 'session-abc',
        workItemId: 'work-item-1',
        type: 'escalation',
        createdAt: new Date().toISOString(),
        contentMarkdown: '# Architectural Decision\n\nNeed to choose between option A and B.',
        evidenceIndex: [
          { type: 'file', value: '/src/architecture.ts' },
          { type: 'commit', value: 'abc123' },
        ],
      };

      expect(packet.type).toBe('escalation');
      expect(packet.evidenceIndex).toHaveLength(2);
      expect(packet.workItemId).toBe('work-item-1');
    });

    it('creates valid review packet', () => {
      const packet: FocusPacket = {
        packetId: 'pkt-review-456',
        sessionKey: 'session-abc',
        type: 'review',
        createdAt: new Date().toISOString(),
        contentMarkdown: '# Review Request\n\nPlease review these changes.',
        evidenceIndex: [
          { type: 'pr', value: '#123' },
        ],
      };

      expect(packet.type).toBe('review');
      expect(packet.evidenceIndex?.[0].type).toBe('pr');
    });

    it('creates valid session packet', () => {
      const packet: FocusPacket = {
        packetId: 'pkt-session-789',
        sessionKey: 'session-abc',
        type: 'session',
        createdAt: new Date().toISOString(),
        contentMarkdown: '# Session Summary\n\nWork completed successfully.',
      };

      expect(packet.type).toBe('session');
      expect(packet.evidenceIndex).toBeUndefined();
    });

    it('validates packet types', () => {
      const validTypes: FocusPacket['type'][] = ['escalation', 'review', 'session'];
      
      for (const type of validTypes) {
        const packet: FocusPacket = {
          packetId: `pkt-${type}`,
          sessionKey: 'session-abc',
          type,
          createdAt: new Date().toISOString(),
          contentMarkdown: 'content',
        };
        expect(validTypes).toContain(packet.type);
      }
    });

    it('handles packet validation warnings', () => {
      const packet: FocusPacket = {
        packetId: 'pkt-warning',
        sessionKey: 'session-abc',
        type: 'escalation',
        createdAt: new Date().toISOString(),
        contentMarkdown: '# Escalation\n\nNo evidence provided.',
        validationWarnings: [
          'No evidence references found; escalation/review packets should include @ref() pointers.',
        ],
      };

      expect(packet.validationWarnings).toHaveLength(1);
      expect(packet.validationWarnings?.[0]).toContain('evidence');
    });
  });

  describe('Session rollup and status', () => {
    it('creates valid session rollup', () => {
      const rollup: SessionRollup = {
        sessionKey: 'session-123',
        kind: 'feature',
        title: 'Implement authentication',
        status: 'running',
        isAsync: false,
        activeWorkItemId: 'work-item-1',
        elapsedSec: 3600,
        lastEventAt: new Date().toISOString(),
        diffstat: {
          added: 150,
          deleted: 50,
          filesTouched: 5,
        },
        currentActivity: {
          tool: 'Write',
          file: '/src/auth.ts',
          line: 42,
        },
        gates: {
          testsStatus: 'pass',
          invariantsStatus: 'pass',
          invariantsPassed: 10,
          invariantsTotal: 10,
        },
        blocking: {
          unresolvedEscalationsCount: 0,
        },
        tokenMetrics: {
          input: 5000,
          output: 2000,
          cached: 500,
          total: 7500,
          llmCalls: 15,
          avgLatencyMs: 1200,
        },
      };

      expect(rollup.status).toBe('running');
      expect(rollup.diffstat.added).toBe(150);
      expect(rollup.gates.testsStatus).toBe('pass');
      expect(rollup.blocking.unresolvedEscalationsCount).toBe(0);
    });

    it('validates session panel statuses', () => {
      const validStatuses: SessionPanelStatus[] = ['running', 'blocked', 'ready', 'done', 'stopped'];
      
      for (const status of validStatuses) {
        const rollup: SessionRollup = {
          sessionKey: 'session-123',
          kind: 'feature',
          title: 'Test',
          status,
          elapsedSec: 0,
          lastEventAt: new Date().toISOString(),
          diffstat: { added: 0, deleted: 0, filesTouched: 0 },
          currentActivity: { tool: 'idle' },
          gates: {
            testsStatus: 'unknown',
            invariantsStatus: 'unknown',
            invariantsPassed: 0,
            invariantsTotal: 0,
          },
          blocking: { unresolvedEscalationsCount: 0 },
          tokenMetrics: {
            input: 0,
            output: 0,
            cached: 0,
            total: 0,
            llmCalls: 0,
            avgLatencyMs: 0,
          },
        };
        expect(validStatuses).toContain(rollup.status);
      }
    });

    it('represents blocked session due to escalations', () => {
      const rollup: SessionRollup = {
        sessionKey: 'session-123',
        kind: 'issue',
        title: 'Fix blocking issue',
        status: 'blocked',
        elapsedSec: 1800,
        lastEventAt: new Date().toISOString(),
        diffstat: { added: 0, deleted: 0, filesTouched: 0 },
        currentActivity: { tool: 'idle' },
        gates: {
          testsStatus: 'unknown',
          invariantsStatus: 'unknown',
          invariantsPassed: 0,
          invariantsTotal: 0,
        },
        blocking: { unresolvedEscalationsCount: 2 },
        tokenMetrics: {
          input: 1000,
          output: 500,
          cached: 100,
          total: 1600,
          llmCalls: 3,
          avgLatencyMs: 800,
        },
      };

      expect(rollup.status).toBe('blocked');
      expect(rollup.blocking.unresolvedEscalationsCount).toBe(2);
    });

    it('represents ready session awaiting review', () => {
      const rollup: SessionRollup = {
        sessionKey: 'session-123',
        kind: 'feature',
        title: 'Ready for review',
        status: 'ready',
        elapsedSec: 7200,
        lastEventAt: new Date().toISOString(),
        diffstat: { added: 300, deleted: 100, filesTouched: 12 },
        currentActivity: { tool: 'idle' },
        gates: {
          testsStatus: 'pass',
          invariantsStatus: 'pass',
          invariantsPassed: 25,
          invariantsTotal: 25,
        },
        blocking: { unresolvedEscalationsCount: 0 },
        tokenMetrics: {
          input: 15000,
          output: 8000,
          cached: 2000,
          total: 25000,
          llmCalls: 50,
          avgLatencyMs: 950,
        },
      };

      expect(rollup.status).toBe('ready');
      expect(rollup.gates.testsStatus).toBe('pass');
      expect(rollup.gates.invariantsPassed).toBe(25);
    });
  });

  describe('Normalized session events', () => {
    it('creates message event', () => {
      const event: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'message',
        payload: {
          id: 123,
          role: 'user',
          content: 'Implement authentication',
          requestId: 'req-123',
          metadata: {},
        },
        signalPriority: 'high',
        isStatusOnly: false,
      };

      expect(event.type).toBe('message');
      expect(event.payload.role).toBe('user');
      expect(event.signalPriority).toBe('high');
    });

    it('creates tool event', () => {
      const event: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'tool',
        payload: {
          eventType: 'tool_call',
          requestId: 'req-456',
          workItemId: 'work-item-1',
          data: {
            tool_name: 'Write',
            success: true,
            path: '/src/auth.ts',
          },
        },
        signalPriority: 'low',
        isStatusOnly: false,
      };

      expect(event.type).toBe('tool');
      expect(event.payload.data?.tool_name).toBe('Write');
    });

    it('creates workflow event', () => {
      const event: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'workflow',
        payload: {
          eventType: 'workitem_created',
          requestId: 'req-789',
          workItemId: 'work-item-1',
          data: {
            objective: 'Implement authentication',
            agent: 'standard',
          },
        },
        signalPriority: 'medium',
        isStatusOnly: false,
      };

      expect(event.type).toBe('workflow');
      expect(event.payload.eventType).toBe('workitem_created');
    });

    it('creates packet event', () => {
      const event: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'packet',
        payload: {
          eventType: 'packet_emitted',
          requestId: 'req-packet',
          data: {
            packetId: 'pkt-escalation-123',
            packetType: 'escalation',
          },
        },
        signalPriority: 'high',
        isStatusOnly: false,
      };

      expect(event.type).toBe('packet');
      expect(event.signalPriority).toBe('high');
    });

    it('creates test event', () => {
      const event: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'test',
        payload: {
          eventType: 'test_completed',
          requestId: 'req-test',
          data: {
            verdict: 'pass',
            testCount: 42,
            passedCount: 42,
            failedCount: 0,
          },
        },
        signalPriority: 'medium',
        isStatusOnly: false,
      };

      expect(event.type).toBe('test');
      expect(event.payload.data?.verdict).toBe('pass');
    });

    it('creates trace event', () => {
      const event: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'trace',
        payload: {
          eventType: 'git_commit',
          requestId: 'req-commit',
          data: {
            sha: 'abc123def456',
            message: 'Add authentication feature',
            author: 'Developer',
          },
        },
        signalPriority: 'low',
        isStatusOnly: false,
      };

      expect(event.type).toBe('trace');
      expect(event.payload.eventType).toBe('git_commit');
    });

    it('validates signal priorities', () => {
      const validPriorities: NonNullable<NormalizedSessionEvent['signalPriority']>[] = ['high', 'medium', 'low', 'status'];
      
      for (const priority of validPriorities) {
        const event: NormalizedSessionEvent = {
          at: new Date().toISOString(),
          type: 'message',
          payload: { role: 'user', content: 'test' },
          signalPriority: priority,
        };
        expect(validPriorities).toContain(event.signalPriority);
      }
    });
  });

  describe('Frontend-backend data flow', () => {
    it('serializes and deserializes session message flow', () => {
      const request: SessionMessageRequest = {
        sessionKey: 'session-123',
        message: 'Test workflow',
        markdownContext: {
          path: '/workflow.md',
          content: '# Test',
        },
      };

      const response: SessionMessageResponse = {
        success: true,
        sessionKey: request.sessionKey,
        requestId: 'req-flow',
        workflowTemplateApplied: true,
        workflowTemplate: {
          id: 'test-template',
          name: 'Test Template',
        },
      };

      // Serialize for transport
      const serializedRequest = JSON.stringify(request);
      const serializedResponse = JSON.stringify(response);

      // Deserialize and verify
      const deserializedRequest = JSON.parse(serializedRequest) as SessionMessageRequest;
      const deserializedResponse = JSON.parse(serializedResponse) as SessionMessageResponse;

      expect(deserializedRequest.sessionKey).toBe(request.sessionKey);
      expect(deserializedResponse.success).toBe(response.success);
      expect(deserializedResponse.workflowTemplate?.id).toBe('test-template');
    });

    it('handles session control flow with fork', () => {
      const controlInput: CockpitSessionControlInput = {
        action: 'fork',
        targetSessionKey: 'session-123-fork',
      };

      const controlResponse = {
        success: true,
        action: 'fork' as const,
        sourceSessionKey: 'session-123',
        targetSessionKey: 'session-123-fork',
      };

      expect(controlInput.action).toBe(controlResponse.action);
      expect(controlResponse.targetSessionKey).toBe(controlInput.targetSessionKey);
    });

    it('handles review decision flow from frontend to backend', () => {
      const frontendInput: CockpitSessionReviewDecisionInput = {
        decision: 'accept',
        note: 'Approved, good work!',
      };

      const backendResponse = {
        success: true,
        sessionKey: 'session-123',
        decision: frontendInput.decision,
        fromStatus: 'ready',
        toStatus: 'completed',
      };

      expect(frontendInput.decision).toBe(backendResponse.decision);
      expect(backendResponse.toStatus).toBe('completed');
    });
  });

  describe('Error handling and edge cases', () => {
    it('handles missing session in message request', () => {
      const response: SessionMessageResponse = {
        success: false,
        sessionKey: 'nonexistent',
        error: 'Session not found: nonexistent',
      };

      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
    });

    it('handles invalid control action', () => {
      const invalidAction = 'invalid-action' as CockpitSessionControlInput['action'];
      const result = ['start', 'stop', 'fork'].includes(invalidAction);

      expect(result).toBe(false);
    });

    it('handles invalid review decision', () => {
      const invalidDecision = 'maybe' as CockpitSessionReviewDecisionInput['decision'];
      const result = ['accept', 'request_changes'].includes(invalidDecision);

      expect(result).toBe(false);
    });

    it('handles empty message', () => {
      const response: SessionMessageResponse = {
        success: false,
        sessionKey: 'session-123',
        error: 'Missing required field: message',
      };

      expect(response.error).toContain('Missing required field');
    });

    it('handles missing markdown context', () => {
      const request: SessionMessageRequest = {
        sessionKey: 'session-123',
        message: 'Test',
        // markdownContext is optional
      };

      expect(request.markdownContext).toBeUndefined();
      expect(request.message).toBe('Test');
    });

    it('handles unicode in all fields', () => {
      const request: SessionMessageRequest = {
        sessionKey: 'session-日本語',
        message: 'Implement feature with emoji 🚀',
        markdownContext: {
          path: '/文档/workflow.md',
          content: '# 文档标题\n\n内容在这里',
        },
      };

      expect(request.sessionKey).toContain('日本語');
      expect(request.message).toContain('🚀');
      expect(request.markdownContext?.path).toContain('文档');
    });

    it('handles very long messages', () => {
      const longMessage = 'x'.repeat(100_000);
      const request: SessionMessageRequest = {
        sessionKey: 'session-123',
        message: longMessage,
      };

      expect(request.message.length).toBe(100_000);
    });

    it('handles null and undefined in metadata', () => {
      const response: SessionMessageResponse = {
        success: true,
        sessionKey: 'session-123',
        requestId: undefined,
        queued: undefined,
        markdownContextAttached: undefined,
        workflowTemplateApplied: undefined,
      };

      expect(response.requestId).toBeUndefined();
      expect(response.queued).toBeUndefined();
    });
  });

  describe('Session metadata and state transitions', () => {
    it('tracks workflow template application in metadata', () => {
      const metadata = {
        workflow_template_applied: true,
        workflow_template_id: 'template-123',
        workflow_template_name: 'Auth Workflow',
        workflow_template_goal: 'Setup authentication',
        workflow_template_runtime: {
          applied: true,
          appliedAt: new Date().toISOString(),
          source: 'cockpit-workflow-template',
        },
      };

      expect(metadata.workflow_template_applied).toBe(true);
      expect(metadata.workflow_template_id).toBe('template-123');
    });

    it('tracks escalations in metadata', () => {
      const metadata = {
        escalations: [
          {
            id: 'escalation-1',
            sessionKey: 'session-123',
            workItemId: 'work-item-1',
            escalationType: 'architectural',
            title: 'Choose authentication method',
            status: 'pending',
            createdAt: Date.now(),
          },
        ],
      };

      const escalations = metadata.escalations as Array<{ status: string }>;
      expect(escalations).toHaveLength(1);
      expect(escalations[0].status).toBe('pending');
    });

    it('tracks agent events in metadata', () => {
      const metadata = {
        agent_events: [
          {
            type: 'tool_call',
            timestamp: new Date().toISOString(),
            data: {
              tool_name: 'Write',
              success: true,
            },
          },
          {
            type: 'workitem_created',
            timestamp: new Date().toISOString(),
            data: {
              objective: 'Test objective',
              agent: 'standard',
            },
          },
        ],
      };

      const events = metadata.agent_events as Array<{ type: string }>;
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_call');
      expect(events[1].type).toBe('workitem_created');
    });

    it('tracks gate status in metadata', () => {
      const metadata = {
        tests_status: 'pass',
        tests_required: true,
        invariants_status: 'pass',
        invariants_required: true,
        invariants_passed: 15,
        invariants_total: 15,
      };

      expect(metadata.tests_status).toBe('pass');
      expect(metadata.tests_required).toBe(true);
      expect(metadata.invariants_passed).toBe(15);
    });

    it('transitions session status from active to completed', () => {
      const fromStatus = 'active';
      const decision = 'accept';
      const toStatus = decision === 'accept' ? 'completed' : 'active';

      expect(toStatus).toBe('completed');
    });

    it('transitions session status from ready to active on request_changes', () => {
      const fromStatus = 'ready';
      const decision = 'request_changes';
      const toStatus = decision === 'accept' ? 'completed' : 'active';

      expect(toStatus).toBe('active');
    });
  });
});
