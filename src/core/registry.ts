import data from "../../signatures/agents.json";
import type { Agent, Registry } from "./types";

export const registry: Registry = data as Registry;

const byId = new Map<string, Agent>(registry.agents.map((a) => [a.id, a]));

export function agentById(id: string): Agent | undefined {
  return byId.get(id);
}

export function agentName(id: string): string {
  return byId.get(id)?.name ?? id;
}

export function agentColor(id: string): string {
  return byId.get(id)?.color ?? "#8b949e";
}
