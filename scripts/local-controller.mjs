import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installExecutable,
  pathExists,
  runLocalController,
  spawnCommand,
  spawnOutput,
} from "./lib/local-controller.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const code = await runLocalController(
    {
      args: process.argv.slice(2),
      home: process.env.HOME || homedir(),
      env: process.env,
      root,
    },
    {
      log: (text) => console.log(text),
      exists: pathExists,
      install: installExecutable,
      async run(command, args, cwd) {
        const failure = await spawnCommand(command, args, cwd);
        if (failure) process.exit(failure.code);
      },
      output: spawnOutput,
    },
  );
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
