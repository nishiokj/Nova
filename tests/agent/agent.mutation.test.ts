import { Agent } from 'agent/agent.js';

describe('Agent public API cutover', () => {
  it('exposes executeTurn with no run compatibility alias', () => {
    expect(typeof Agent.prototype.executeTurn).toBe('function');
    expect(Object.prototype.hasOwnProperty.call(Agent.prototype, 'run')).toBe(false);
  });
});
