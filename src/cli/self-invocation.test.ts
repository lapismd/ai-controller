import { afterEach, expect, it, vi } from "vitest";
import { currentSelfInvocation } from "./self.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("preserves absolute Deno and snapshot entry when the service has no shell", () => {
  vi.stubGlobal("Deno", {
    execPath: () => "/opt/deno",
    mainModule: "file:///installed%20release/cli.js",
    build: {},
  });
  vi.stubEnv("LAPIS_CLI_RELEASE", "/installed release");
  const invocation = currentSelfInvocation();
  expect(invocation.command).toBe("/opt/deno");
  expect(invocation.argsPrefix).toContain("--no-config");
  expect(invocation.argsPrefix).toContain("--no-lock");
  expect(invocation.argsPrefix).toContain("--node-modules-dir=manual");
  expect(invocation.argsPrefix.at(-1)).toMatch(/installed(?:%20| )release/);
});
it("retains a remote JSR entrypoint URL instead of treating it as a filesystem path", () => {
  vi.stubGlobal("Deno", {
    execPath: () => "/opt/deno",
    mainModule: "https://jsr.io/@lapismd/example/0.1.0/cli.js",
    build: {},
  });
  vi.stubEnv("LAPIS_CLI_RELEASE", "");
  const invocation = currentSelfInvocation();
  expect(invocation.argsPrefix.at(-1)).toBe(
    "https://jsr.io/@lapismd/example/0.1.0/cli.js",
  );
  expect(invocation.argsPrefix).toContain("--no-config");
});
