import type { ToolDefinition } from "../contracts.js";

export const memoryToolDefinitions: ToolDefinition[] = [
  {
    name: "memory_search",
    description: "Search authorized memory with evidence references",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Read an authorized memory and verify its evidence",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
];
