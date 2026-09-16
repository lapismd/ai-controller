import { Ajv } from "ajv";
import { ControllerError } from "../contracts.js";
import type { McpServerContribution } from "../execution/compat/types.js";
const string = { type: "string", minLength: 1, maxLength: 10000 };
const strings = {
  type: "array",
  maxItems: 200,
  items: { type: "string", maxLength: 10000 },
};
const validate = new Ajv({ strict: true }).compile({
  type: "array",
  maxItems: 50,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "command"],
    properties: {
      name: { type: "string", pattern: "^[a-zA-Z0-9_.-]{1,128}$" },
      command: string,
      args: strings,
      cwd: string,
      env: {
        type: "object",
        maxProperties: 100,
        additionalProperties: { type: "string", maxLength: 10000 },
      },
      enabledTools: strings,
    },
  },
});
export function validateMcpServers(
  value: unknown,
): asserts value is McpServerContribution[] {
  if (
    !validate(value) ||
    new Set((value as McpServerContribution[]).map((server) => server.name))
      .size !== (value as unknown[]).length
  )
    throw new ControllerError(
      "invalid_mcp",
      "External MCP launch description is invalid",
    );
}
