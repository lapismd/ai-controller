import { runCli } from "./cli/main.js";
import { runManagedChild } from "./cli/managed-child.js";
import { runMcpShim } from "@lapismd/ai-host";
const argv = process.argv.slice(2);
if (argv[0] === "__internal" && argv[1] === "mcp-shim") await runMcpShim();
else if (argv[0] === "__internal" && argv[1] === "managed") {
  try {
    await runManagedChild();
  } catch {
    console.error("Controller managed startup failed; check configuration");
    process.exitCode = 1;
  }
} else process.exitCode = await runCli(argv);
