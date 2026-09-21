import {
  isEmptyToolInput,
  isGenericToolName,
  preferToolName,
  toolNameFromInput,
} from "./tool-identity.js";
import type { Json } from "../../contracts.js";

export type ToolSnapshot = {
  id: string;
  name: string;
  kind?: string;
  title?: string;
  command?: string;
  server?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  locations?: unknown[];
  content?: unknown;
};

export function extractToolCommand(
  input: unknown,
  title?: string,
): string | undefined {
  const direct = normalizeCommandValue(input);
  if (direct) return direct;
  const record = asRecord(input);
  if (record) {
    const item = asRecord(record.item);
    const candidates = [
      normalizeCommandValue(record.command),
      normalizeCommandValue(item?.command),
      normalizeCommandValue(asRecord(item?.input)?.command),
      normalizeCommandValue(asRecord(item?.result)?.command),
    ];
    const found = candidates.find((value) => value);
    if (found) return found;
    const executable = trimmed(record.executable);
    const args = normalizeCommandValue(record.args);
    if (executable && args) return `${executable} ${args}`;
    if (executable) return executable;
  }
  return extractCommandFromTitle(title);
}

export function toolDisplayInput(
  snapshot: Pick<ToolSnapshot, "input" | "command" | "locations" | "kind">,
): unknown {
  if (!isEmptyToolInput(snapshot.input)) return snapshot.input;
  const envelope: Record<string, unknown> = {};
  if (snapshot.command) envelope.command = snapshot.command;
  if (snapshot.locations && snapshot.locations.length > 0) {
    envelope.locations = snapshot.locations;
  }
  if (snapshot.kind) envelope.kind = snapshot.kind;
  return Object.keys(envelope).length > 0 ? envelope : undefined;
}

export function firstLocationPath(locations: unknown): string | undefined {
  if (!Array.isArray(locations)) return undefined;
  for (const entry of locations) {
    const record = asRecord(entry);
    const path = trimmed(record?.path);
    if (path) return path;
  }
  return undefined;
}

export function snapshotFromToolActivity(
  data: Record<string, unknown>,
): ToolSnapshot {
  const title = trimmed(data.title);
  const rawInput = data.rawInput ?? data.input;
  const locations = Array.isArray(data.locations) ? data.locations : undefined;
  const command =
    trimmed(data.command) ?? extractToolCommand(rawInput, title);
  const input = !isEmptyToolInput(rawInput)
    ? rawInput
    : locations && locations.length > 0
      ? { locations }
      : undefined;
  const kind = trimmed(data.kind);
  const name = preferToolName(
    undefined,
    trimmed(data.name) ??
      (title && !isGenericToolName(title) ? title : undefined) ??
      toolNameFromInput(rawInput) ??
      kind ??
      command,
  );
  return {
    id: String(data.id ?? data.toolCallId ?? "tool"),
    name,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(command ? { command } : {}),
    ...(trimmed(data.server) ? { server: trimmed(data.server) } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(data.output !== undefined ? { output: data.output } : {}),
    ...(data.error !== undefined ? { error: data.error } : {}),
    ...(locations ? { locations } : {}),
    ...(data.content !== undefined ? { content: data.content } : {}),
  };
}

export function mergeToolSnapshot(
  previous: ToolSnapshot | undefined,
  next: ToolSnapshot,
): ToolSnapshot {
  const input = !isEmptyToolInput(next.input) ? next.input : previous?.input;
  const locations = next.locations?.length
    ? next.locations
    : previous?.locations;
  const command = next.command ?? previous?.command;
  const kind = next.kind ?? previous?.kind;
  const merged: ToolSnapshot = {
    id: next.id || previous?.id || "tool",
    name: preferToolName(previous?.name, next.name),
  };
  if (kind) merged.kind = kind;
  if (next.title ?? previous?.title) merged.title = next.title ?? previous?.title;
  if (command) merged.command = command;
  if (next.server ?? previous?.server) merged.server = next.server ?? previous?.server;
  if (input !== undefined) merged.input = input;
  if (next.output !== undefined) merged.output = next.output;
  else if (previous?.output !== undefined) merged.output = previous.output;
  if (next.error !== undefined) merged.error = next.error;
  else if (previous?.error !== undefined) merged.error = previous.error;
  if (locations) merged.locations = locations;
  if (next.content !== undefined) merged.content = next.content;
  else if (previous?.content !== undefined) merged.content = previous.content;
  const display = toolDisplayInput(merged);
  if (display !== undefined) merged.input = display;
  return merged;
}

export function mergeToolActivity(
  previous: Record<string, Json> | undefined,
  data: Record<string, Json>,
): Record<string, Json> {
  return snapshotToActivity(
    mergeToolSnapshot(
      previous ? snapshotFromToolActivity(previous) : undefined,
      snapshotFromToolActivity(data),
    ),
  );
}

export function snapshotToActivity(snapshot: ToolSnapshot): Record<string, Json> {
  const activity: Record<string, Json> = {
    id: snapshot.id,
    name: snapshot.name,
  };
  if (snapshot.kind) activity.kind = snapshot.kind;
  if (snapshot.title) activity.title = snapshot.title;
  if (snapshot.command) activity.command = snapshot.command;
  if (snapshot.server) activity.server = snapshot.server;
  const input = asJson(toolDisplayInput(snapshot));
  if (input !== undefined) activity.input = input;
  const output = asJson(snapshot.output);
  if (output !== undefined) activity.output = output;
  const error = asJson(snapshot.error);
  if (error !== undefined) activity.error = error;
  const locations = asJson(snapshot.locations);
  if (locations !== undefined) activity.locations = locations;
  const content = asJson(snapshot.content);
  if (content !== undefined) activity.content = content;
  return activity;
}

export function toolStartProjection(snapshot: ToolSnapshot): Record<string, Json> {
  return {
    type: "tool.start",
    id: snapshot.id,
    name: snapshot.name,
    pending: true,
    ...(snapshot.kind ? { kind: snapshot.kind } : {}),
    ...(snapshot.command ? { command: snapshot.command } : {}),
  };
}

export function toolEndActivity(snapshot: ToolSnapshot): Record<string, Json> {
  return {
    type: "tool.end",
    ...snapshotToActivity(snapshot),
  };
}

export function usageCost(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  const record = asRecord(value);
  const amount = record?.amount ?? record?.total;
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
    return amount;
  }
  return undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = trimmed(value);
  if (direct) return direct;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((entry) => {
    const part = trimmed(entry);
    return part ? [part] : [];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = /`([^`]+)`/u.exec(title);
  return match?.[1]?.trim() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function asJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}
