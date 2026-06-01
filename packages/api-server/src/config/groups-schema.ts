import { z } from 'zod';

const ContainerConfigSchema = z.object({
  baseImage: z.string(),
  maxSessions: z.number().int().positive().max(1000),
  env: z.record(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  resources: z
    .object({
      cpus: z.string().optional(),
      memory: z.string().optional(),
    })
    .optional(),
});

const RoutingConfigSchema = z.object({
  mode: z.enum(['explicit', 'auto', 'round-robin']),
  fallback: z.string().optional(),
  autoClassifierModel: z.string().optional(),
});

const GroupConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'group id must be kebab-case'),
  displayName: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  enabled: z.boolean().default(true),
  agents: z.array(z.string()).min(1),
  defaultAgent: z.string().optional(),
  container: ContainerConfigSchema,
  routing: RoutingConfigSchema,
  // channels removed in v0.3 - use messaging_groups table instead
});

export const GroupsYamlSchema = z.object({
  version: z.literal(1).default(1),
  groups: z.array(GroupConfigSchema).min(1),
});

export type GroupsYaml = z.infer<typeof GroupsYamlSchema>;

/**
 * 額外語意檢查：
 *  - defaultAgent 必須在 agents 陣列中
 *  - routing.fallback 必須在 agents 陣列中
 */
export function validateGroupsSemantics(yaml: GroupsYaml): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const g of yaml.groups) {
    if (seen.has(g.id)) errors.push(`duplicate group id: ${g.id}`);
    seen.add(g.id);

    if (g.defaultAgent && !g.agents.includes(g.defaultAgent)) {
      errors.push(`group ${g.id}: defaultAgent "${g.defaultAgent}" not in agents`);
    }
    if (g.routing.fallback && !g.agents.includes(g.routing.fallback)) {
      errors.push(`group ${g.id}: routing.fallback "${g.routing.fallback}" not in agents`);
    }
  }
  return errors;
}
