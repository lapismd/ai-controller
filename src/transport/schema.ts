import { Ajv } from "ajv";
import { ControllerError } from "../contracts.js";
const string = { type: "string", minLength: 1, maxLength: 512 };
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
const config = object({
  vcsIdentity: object({
    name: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\r\\n\\u0000]+$" },
    email: { type: "string", minLength: 1, maxLength: 320, pattern: "^[^\\r\\n\\u0000]+$" },
  }, ["name", "email"]),
  restricted: { type: "boolean" },
  model: string,
  agent: string,
  thinking: string,
  options: { type: "object" },
});
const stringArray = { type: "array", items: string, maxItems: 100 };
const schemas: Record<string, object> = {
  "system.status": object({}),
  "providers.list": object({}),
  "interactions.list": object({ threadId: string }, ["threadId"]),
  "tools.list": object({ threadId: string }, ["threadId"]),
  "providers.models": object({ provider: string, workspace: string }, [
    "provider",
    "workspace",
  ]),
  "threads.configure": object(
    {
      threadId: string,
      version: { type: "integer", minimum: 1 },
      configuration: config,
    },
    ["threadId", "version", "configuration"],
  ),
  "threads.create": object(
    {
      id: string,
      provider: string,
      workspace: string,
      externalRef: string,
      payloadPolicy: { enum: ["durable", "metadata-only"] },
      configuration: config,
      contextSources: stringArray,
      toolEndpoint: string,
      memoryEndpoint: string,
      mcpEndpoint: string,
    },
    ["provider", "workspace"],
  ),
  "threads.list": object({}),
  "threads.snapshot": object({ threadId: string }, ["threadId"]),
  "turns.submit": object(
    {
      threadId: string,
      commandId: string,
      text: { type: "string", maxLength: 1_000_000 },
      externalRef: string,
      parts: {
        type: "array",
        maxItems: 100,
        items: object(
          {
            type: { enum: ["text", "resource", "image"] },
            text: { type: "string", maxLength: 1_000_000 },
            uri: { type: "string", maxLength: 10000 },
            mimeType: string,
          },
          ["type"],
        ),
      },
    },
    ["threadId", "commandId", "text"],
  ),
  "turns.get": object({ turnId: string }, ["turnId"]),
  "turns.cancel": object({ turnId: string }, ["turnId"]),
  "turns.resolve": object(
    {
      turnId: string,
      outcome: { enum: ["failed", "cancelled"] },
      externalStopped: { const: true },
    },
    ["turnId", "outcome", "externalStopped"],
  ),
  "commands.get": object({ commandId: string }, ["commandId"]),
  "events.read": object(
    {
      threadId: string,
      after: string,
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    ["threadId", "after"],
  ),
  "events.subscribe": object({ threadId: string, after: string }, ["threadId"]),
  "events.unsubscribe": object({ threadId: string }, ["threadId"]),
  "interactions.respond": object({ id: string, response: {} }, [
    "id",
    "response",
  ]),
  "context.get": object({ turnId: string }, ["turnId"]),
  "memory.search": object({ threadId: string, input: { type: "object" } }, [
    "threadId",
    "input",
  ]),
  "memory.get": object({ threadId: string, input: { type: "object" } }, [
    "threadId",
    "input",
  ]),
  "endpoints.register": object(
    {
      id: string,
      memory: object({ profile: { enum: ["lapis-v1", "nostr-v1"] } }, [
        "profile",
      ]),
      context: { type: "boolean" },
      mcp: { type: "boolean" },
      capture: { type: "boolean" },
      required: { type: "boolean" },
      tools: {
        type: "array",
        maxItems: 200,
        items: object(
          {
            name: string,
            description: { type: "string", maxLength: 5000 },
            effect: { enum: ["read", "idempotent", "reconcilable", "write"] },
            inputSchema: { type: "object" },
          },
          ["name", "description", "effect", "inputSchema"],
        ),
      },
    },
    ["id"],
  ),
  "endpoints.respond": object(
    { id: string, result: {}, failed: { type: "boolean" } },
    ["id", "result"],
  ),
  "endpoints.unregister": object({ id: string }, ["id"]),
};
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
);
export function requestMethods(): string[] {
  return Object.keys(schemas);
}
export function validateRequest(
  method: string,
  params: unknown,
): asserts params is Record<string, unknown> {
  const validate = validators.get(method);
  if (!validate)
    throw new ControllerError("method_unknown", "Unknown controller operation");
  if (!validate(params))
    throw new ControllerError(
      "invalid_input",
      "Request does not match the operation schema",
    );
}
