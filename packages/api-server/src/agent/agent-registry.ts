import type { AgentMetadata } from '@zeroclaw/shared';
import { Errors } from '@zeroclaw/shared';
import { scanAgentsDir } from './agent-detector.js';

export interface AgentRegistry {
  list(): AgentMetadata[];
  get(id: string): AgentMetadata;
  tryGet(id: string): AgentMetadata | undefined;
  reload(): Promise<void>;
}

export async function createAgentRegistry(agentsDir: string): Promise<AgentRegistry> {
  let cache = new Map<string, AgentMetadata>();

  async function load(): Promise<void> {
    const found = await scanAgentsDir(agentsDir);
    cache = new Map(found.map((a) => [a.id, a]));
  }

  await load();

  return {
    list: () => Array.from(cache.values()),
    get: (id) => {
      const agent = cache.get(id);
      if (!agent) throw Errors.agentNotFound(id);
      return agent;
    },
    tryGet: (id) => cache.get(id),
    reload: load,
  };
}
