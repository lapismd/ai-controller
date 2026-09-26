import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export type SelfInvocation = { command: string; argsPrefix: string[] };
export function currentSelfInvocation(): SelfInvocation {
  const deno = (
    globalThis as {
      Deno?: {
        build: { standalone?: boolean };
        execPath(): string;
        mainModule: string;
      };
    }
  ).Deno;
  if (deno?.build.standalone)
    return { command: deno.execPath(), argsPrefix: [] };
  if (deno)
    return {
      command: deno.execPath(),
      argsPrefix: [
        "run",
        "-A",
        ...(process.env.LAPIS_CLI_RELEASE
          ? ["--no-config", "--no-lock", "--node-modules-dir=manual"]
          : deno.mainModule.startsWith("file:")
            ? ["--sloppy-imports"]
            : ["--no-config", "--no-lock", "--node-modules-dir=none"]),
        deno.mainModule.startsWith("file:")
          ? fileURLToPath(deno.mainModule)
          : deno.mainModule,
      ],
    };
  if (!process.argv[1]) throw new Error("Controller entrypoint is unavailable");
  return { command: process.execPath, argsPrefix: [resolve(process.argv[1])] };
}
