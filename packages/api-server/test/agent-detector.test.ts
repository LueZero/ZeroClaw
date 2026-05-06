import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAgent } from '../src/agent/agent-detector.js';

describe('agent-detector', () => {
  it('detects opencode by opencode.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-'));
    await writeFile(join(dir, 'opencode.json'), '{}');
    await writeFile(join(dir, 'AGENTS.md'), '# x');
    const meta = await detectAgent(dir);
    expect(meta.sdk).toBe('opencode');
  });

  it('detects copilot by AGENTS.md only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-'));
    await writeFile(join(dir, 'AGENTS.md'), '# x');
    const meta = await detectAgent(dir);
    expect(meta.sdk).toBe('copilot');
  });

  it('throws when neither marker present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-'));
    await expect(detectAgent(dir)).rejects.toThrow();
  });

  it('reads sub-agents from .agents/*.md with frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-'));
    await writeFile(join(dir, 'AGENTS.md'), '# x');
    await mkdir(join(dir, '.agents'), { recursive: true });
    await writeFile(
      join(dir, '.agents', 'security.md'),
      '---\ndisplayName: Security\ndescription: sec\nmode: subagent\n---\n# body',
    );
    const meta = await detectAgent(dir);
    expect(meta.subAgents).toHaveLength(1);
    expect(meta.subAgents[0]?.name).toBe('security');
    expect(meta.subAgents[0]?.mode).toBe('subagent');
  });
});
