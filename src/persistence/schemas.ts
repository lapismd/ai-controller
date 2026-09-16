import { Ajv } from "ajv";
import { ControllerError, TERMINAL_STATES } from "../contracts.js";

const string = { type: "string", minLength: 1 };
const text = { type: "string" };
const number = { type: "number", minimum: 0 };
const strings = { type: "array", items: string };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});
const configuration = { type: "object" };
const scope = { threadId: string };
const receipt = object(
  {
    ...scope,
    commandId: string,
    turnId: string,
    acceptedAt: number,
    durability: { enum: ["durable", "metadata-only"] },
  },
  ["threadId", "commandId", "turnId", "acceptedAt", "durability"],
);
const block = object(
  {
    id: string,
    revision: string,
    content: text,
    kind: { enum: ["instructions", "handoff", "memory", "application"] },
    trust: { enum: ["instructions", "reference"] },
    required: { type: "boolean" },
    sourceId: string,
  },
  ["id", "revision", "kind", "content", "trust"],
);
const schemas = {
  threads: object(
    {
      id: string,
      owner: string,
      application: string,
      provider: string,
      workspace: string,
      version: { type: "integer", minimum: 1 },
      createdAt: number,
      payloadPolicy: { enum: ["durable", "metadata-only"] },
      nativeSessionId: string,
      contextSources: strings,
      toolEndpoint: string,
      memoryEndpoint: string,
      mcpEndpoint: string,
      externalRef: string,
      configuration,
    },
    [
      "id",
      "owner",
      "provider",
      "workspace",
      "version",
      "createdAt",
      "payloadPolicy",
    ],
  ),
  turns: object(
    {
      ...scope,
      id: string,
      commandId: string,
      attemptId: string,
      state: {
        enum: [
          "queued",
          "preparing",
          "prepared",
          "dispatching",
          "running",
          "waiting",
          ...TERMINAL_STATES,
        ],
      },
      createdAt: number,
      updatedAt: number,
      cancelRequested: { type: "boolean" },
      text,
      output: text,
      parts: {
        type: "array",
        items: object(
          {
            type: { enum: ["text", "resource", "image"] },
            text,
            uri: string,
            mimeType: string,
          },
          ["type"],
        ),
      },
    },
    [
      "id",
      "threadId",
      "commandId",
      "attemptId",
      "state",
      "createdAt",
      "updatedAt",
      "cancelRequested",
    ],
  ),
  commands: receipt,
  preparations: {
    oneOf: [
      object(
        {
          version: { const: 1 },
          text,
          blocks: { type: "array", items: block },
          omitted: strings,
          configuration,
        },
        ["version", "text", "blocks", "omitted", "configuration"],
      ),
      {
        ...object(
          {
            version: { const: 1 },
            omitted: strings,
            payloadUnavailable: { const: true },
          },
          ["version", "omitted", "payloadUnavailable"],
        ),
        additionalProperties: false,
      },
    ],
  },
  events: object(
    {
      ...scope,
      id: string,
      turnId: string,
      cursor: text,
      type: string,
      at: number,
      data: {},
    },
    ["id", "threadId", "cursor", "type", "at", "data"],
  ),
  interactions: object(
    {
      ...scope,
      id: string,
      turnId: string,
      nativeId: string,
      kind: { enum: ["approval", "input", "tool"] },
      state: {
        enum: ["pending", "resolved", "expired", "cancelled", "unknown"],
      },
      deadline: number,
      request: {},
      response: {},
    },
    [
      "id",
      "threadId",
      "turnId",
      "nativeId",
      "kind",
      "state",
      "deadline",
      "request",
    ],
  ),
};
const ajv = new Ajv({ strict: false });
export const storedTables = Object.keys(schemas) as Array<keyof typeof schemas>;
const validators = Object.fromEntries(
  storedTables.map((table) => [table, ajv.compile(schemas[table])]),
);

/** Validate before recovery can interpret retained state. Never include payloads in errors. */
export function validateStoredRecord(
  table: keyof typeof schemas,
  body: unknown,
): void {
  let valid = false;
  try {
    valid = typeof body === "string" && validators[table]!(JSON.parse(body));
  } catch {
    /* Corruption is a storage error, not provider work. */
  }
  if (!valid)
    throw new ControllerError(
      "storage_corrupt",
      `Invalid persisted ${table} record`,
    );
}
