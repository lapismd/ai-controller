import { ControllerError } from "../contracts.js";

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: 2 | 3 = 2,
  ) {
    super(message);
  }
}

const CONNECTION_CODES = new Set([
  "disconnected",
  "connection_failed",
  "connection_timeout",
  "unavailable",
]);

export function cliFailure(error: unknown): {
  code: string;
  message: string;
  exitCode: 2 | 3;
} {
  if (error instanceof CliError)
    return {
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
    };
  const code =
    error instanceof ControllerError ? error.code : "invalid_arguments";
  const message =
    error instanceof ControllerError ||
    (error instanceof Error &&
      /^Unknown |requires |--|.* requires --/.test(error.message))
      ? (error as Error).message
      : "Command failed; check configuration and service availability";
  return {
    code,
    message,
    exitCode: CONNECTION_CODES.has(code) ? 3 : 2,
  };
}
