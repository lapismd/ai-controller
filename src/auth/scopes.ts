import {
  CONTROLLER_SCOPES,
  ControllerError,
  type ControllerScope,
  type Principal,
} from "../contracts.js";
import { requestMethods } from "../transport/schema.js";

export type ScopeRequirement = ControllerScope | "authenticated";

export const DEFAULT_SCOPES: readonly ControllerScope[] = CONTROLLER_SCOPES;

export const RPC_REQUIRED_SCOPES = {
  "system.status": "authenticated",
  "providers.list": "providers:read",
  "providers.models": "providers:read",
  "threads.create": "threads:operate",
  "threads.list": "threads:read",
  "threads.snapshot": "threads:read",
  "threads.configure": "providers:configure",
  "turns.submit": "threads:operate",
  "turns.get": "threads:read",
  "turns.cancel": "threads:operate",
  "turns.resolve": "threads:operate",
  "commands.get": "threads:read",
  "context.get": "threads:read",
  "tools.list": "threads:read",
  "interactions.list": "threads:read",
  "interactions.respond": "threads:operate",
  "events.read": "threads:read",
  "transcript.replay": "threads:read",
  "events.subscribe": "threads:read",
  "events.unsubscribe": "threads:read",
  "memory.search": "memory:read",
  "memory.get": "memory:read",
  "endpoints.register": "tools:provide",
  "endpoints.respond": "authenticated",
  "endpoints.unregister": "authenticated",
} as const satisfies Record<string, ScopeRequirement>;

export function isControllerScope(value: unknown): value is ControllerScope {
  return (
    typeof value === "string" &&
    (CONTROLLER_SCOPES as readonly string[]).includes(value)
  );
}

export function resolvePrincipal(principal: Principal): Principal & {
  applicationId: string;
  scopes: ControllerScope[];
} {
  return {
    ...principal,
    applicationId: principal.applicationId ?? principal.id,
    scopes: principal.scopes?.length
      ? [...principal.scopes]
      : [...DEFAULT_SCOPES],
  };
}

export function requiredScopeForRpcMethod(method: string): ScopeRequirement {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method))
    throw new ControllerError(
      "method_unknown",
      "Unknown controller operation",
    );
  return RPC_REQUIRED_SCOPES[method as keyof typeof RPC_REQUIRED_SCOPES];
}

export function requiredScopesForRpc(
  method: string,
  params: Record<string, unknown> = {},
): readonly ControllerScope[] | "authenticated" {
  if (method === "endpoints.register")
    return scopesForEndpointRegister(params);
  const required = requiredScopeForRpcMethod(method);
  return required === "authenticated" ? "authenticated" : [required];
}

export function scopesForEndpointRegister(
  params: Record<string, unknown>,
): ControllerScope[] {
  const scopes = new Set<ControllerScope>();
  if (params.tools) scopes.add("tools:provide");
  if (params.memory) scopes.add("memory:read");
  if (params.context || params.mcp || params.transcript) scopes.add("threads:operate");
  if (!scopes.size) scopes.add("threads:operate");
  return [...scopes];
}

export function requireScope(
  session: { scopes: readonly ControllerScope[] },
  method: string,
  params: Record<string, unknown> = {},
): void {
  const required = requiredScopesForRpc(method, params);
  if (required === "authenticated") return;
  for (const scope of required)
    if (!session.scopes.includes(scope))
      throw new ControllerError("forbidden", "Missing required scope");
}

export function narrowScopes(
  granted: readonly ControllerScope[],
  requested: unknown,
): ControllerScope[] {
  if (requested === undefined) return [...granted];
  if (!Array.isArray(requested) || requested.some((item) => !isControllerScope(item)))
    throw new ControllerError("invalid_input", "Requested scopes are invalid");
  const unique = [...new Set(requested)];
  if (unique.some((scope) => !granted.includes(scope)))
    throw new ControllerError(
      "forbidden",
      "Requested scopes exceed the credential grant",
    );
  return unique;
}

export function assertCompleteScopeMap(): void {
  for (const method of requestMethods())
    if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method))
      throw new Error(`RPC method ${method} has no declared authorization scope.`);
}
