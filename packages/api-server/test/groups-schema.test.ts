import { describe, it, expect } from 'vitest';
import { GroupsYamlSchema, validateGroupsSemantics } from '../src/config/groups-schema.js';

describe('groups-schema', () => {
  it('parses minimal valid groups.yaml', () => {
    const data = {
      version: 1,
      groups: [
        {
          id: 'support',
          displayName: 'Support',
          enabled: true,
          agents: ['faq-bot'],
          defaultAgent: 'faq-bot',
          container: { baseImage: 'img:latest', maxSessions: 10 },
          routing: { mode: 'explicit' },
          channels: [],
        },
      ],
    };
    const r = GroupsYamlSchema.safeParse(data);
    expect(r.success).toBe(true);
  });

  it('rejects defaultAgent not in agents', () => {
    const r = GroupsYamlSchema.safeParse({
      version: 1,
      groups: [
        {
          id: 'g1',
          displayName: 'G',
          enabled: true,
          agents: ['a'],
          defaultAgent: 'b',
          container: { baseImage: 'x', maxSessions: 1 },
          routing: { mode: 'explicit' },
          channels: [],
        },
      ],
    });
    expect(r.success).toBe(true); // schema 通過
    if (r.success) {
      const errs = validateGroupsSemantics(r.data);
      expect(errs.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid kebab-case id', () => {
    const r = GroupsYamlSchema.safeParse({
      version: 1,
      groups: [
        {
          id: 'BadID',
          displayName: 'X',
          enabled: true,
          agents: ['a'],
          container: { baseImage: 'x', maxSessions: 1 },
          routing: { mode: 'explicit' },
          channels: [],
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
