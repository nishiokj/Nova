import { describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import * as api from '../lib/api';
import { CockpitStoreImpl, selectActivePermissionRequest } from './use-cockpit-store';

describe('CockpitStoreImpl permission queue', () => {
  it('queues permission requests and exposes the active request', () => {
    const store = new CockpitStoreImpl();

    act(() => {
      store.enqueuePermissionRequest({
        requestId: 'perm-1',
        sessionKey: 'session-1234',
        tool: 'Write',
        target: 'src/index.ts',
        suggestedPattern: 'Write(src/**)',
        workingDirectory: '/repo',
        description: 'Write file',
        createdAt: '2026-02-08T00:00:00.000Z',
      });
    });

    const state = store.getSnapshot();
    expect(state.permissionDialogOpen).toBe(true);
    expect(state.pendingPermissionRequests).toHaveLength(1);
    expect(selectActivePermissionRequest(state)?.requestId).toBe('perm-1');
  });

  it('submits permission response and dequeues active item', async () => {
    const store = new CockpitStoreImpl();
    const permissionSpy = vi
      .spyOn(api, 'postCockpitPermissionResponse')
      .mockResolvedValue({ success: true });

    act(() => {
      store.enqueuePermissionRequest({
        requestId: 'perm-2',
        sessionKey: 'session-1234',
        tool: 'Bash',
        target: 'npm test',
        suggestedPattern: 'Bash(npm *)',
        workingDirectory: '/repo',
        description: 'Run tests',
        createdAt: '2026-02-08T00:00:00.000Z',
      });
    });

    await act(async () => {
      await store.handleRespondToPermissionRequest('allow');
    });

    expect(permissionSpy).toHaveBeenCalledWith({
      sessionKey: 'session-1234',
      requestId: 'perm-2',
      decision: 'allow',
    });
    const state = store.getSnapshot();
    expect(state.pendingPermissionRequests).toHaveLength(0);
    expect(state.permissionDialogOpen).toBe(false);
    expect(state.permissionResponseError).toBeNull();
  });
});
