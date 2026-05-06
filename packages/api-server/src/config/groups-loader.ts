import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Errors } from '@zeroclaw/shared';
import type { GroupConfig, GroupOverride } from '@zeroclaw/shared';
import type { DbStore } from '../db/db-store.js';
import { GroupsYamlSchema, validateGroupsSemantics } from './groups-schema.js';

export interface GroupsRegistry {
  /** Enabled-only groups (after override merge). */
  list(): GroupConfig[];
  /** Lookup an enabled group by id. */
  get(id: string): GroupConfig | undefined;
  /** All groups including disabled — admin UI only. */
  listAll(): GroupConfig[];
  /** Re-read yaml + DB overrides. */
  reload(): Promise<void>;
}

function applyOverride(base: GroupConfig, override: GroupOverride | undefined): GroupConfig {
  if (!override) return base;
  return {
    ...base,
    displayName: override.displayName ?? base.displayName,
    description: override.description ?? base.description,
    icon: override.icon ?? base.icon,
    enabled: override.enabled ?? base.enabled,
    defaultAgent: override.defaultAgent ?? base.defaultAgent,
    container: override.maxSessions != null
      ? { ...base.container, maxSessions: override.maxSessions }
      : base.container,
    routing: (override.routingMode != null || override.routingFallback !== undefined || override.routingAutoClassifierModel !== undefined)
      ? {
          ...base.routing,
          ...(override.routingMode != null && { mode: override.routingMode as 'explicit' | 'auto' | 'round-robin' }),
          ...(override.routingFallback !== undefined && override.routingFallback !== null && { fallback: override.routingFallback }),
          ...(override.routingFallback === null && { fallback: undefined }),
          ...(override.routingAutoClassifierModel !== undefined && override.routingAutoClassifierModel !== null && { autoClassifierModel: override.routingAutoClassifierModel }),
          ...(override.routingAutoClassifierModel === null && { autoClassifierModel: undefined }),
        }
      : base.routing,
  };
}

export async function createGroupsRegistry(
  filePath: string,
  db: DbStore,
): Promise<GroupsRegistry> {
  const absolute = resolve(filePath);
  let merged: GroupConfig[] = [];

  async function load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(absolute, 'utf8');
    } catch (e) {
      throw Errors.configInvalid(`Cannot read groups file: ${absolute}`, {
        cause: (e as Error).message,
      });
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw Errors.configInvalid(`Invalid YAML in ${absolute}`, {
        cause: (e as Error).message,
      });
    }

    const result = GroupsYamlSchema.safeParse(parsed);
    if (!result.success) {
      throw Errors.configInvalid(`groups.yaml schema validation failed`, {
        issues: result.error.issues,
      });
    }

    const semanticErrors = validateGroupsSemantics(result.data);
    if (semanticErrors.length > 0) {
      throw Errors.configInvalid(`groups.yaml semantic validation failed`, {
        errors: semanticErrors,
      });
    }

    const yamlGroups = result.data.groups as GroupConfig[];
    const overrides = await db.listGroupOverrides();
    const overrideMap = new Map(overrides.map((o) => [o.groupId, o]));

    merged = yamlGroups.map((g) => applyOverride(g, overrideMap.get(g.id)));
  }

  await load();

  return {
    list: () => merged.filter((g) => g.enabled),
    get: (id) => merged.find((g) => g.id === id && g.enabled),
    listAll: () => merged.slice(),
    reload: load,
  };
}
