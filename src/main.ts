import { runCli } from "./cli/main.js";
import { runMcpShim } from "@lapismd/ai-host";
const argv = process.argv.slice(2);
if (argv[0] === "__internal" && argv[1] === "mcp-shim") await runMcpShim();
else process.exitCode = await runCli(argv);
