export interface CommandSpec {
  path: string;
  summary: string;
  options: string[];
  required?: string[];
}
export const COMMANDS: CommandSpec[] = [
  {
    path: "init",
    summary: "Initialize private configuration and credentials.",
    options: ["workspace"],
    required: ["workspace"],
  },
  {
    path: "serve",
    summary: "Run the durable controller and its execution providers.",
    options: [],
  },
  {
    path: "status",
    summary: "Inspect the running controller.",
    options: ["watch"],
  },
  {
    path: "doctor",
    summary:
      "Check local configuration and permissions without starting agents.",
    options: [],
  },
  {
    path: "config show",
    summary: "Show configuration with credential references.",
    options: [],
  },
  {
    path: "config validate",
    summary: "Validate configuration and private credentials.",
    options: [],
  },
  ...["install", "start", "stop", "restart", "status", "uninstall"].map(
    (action) => ({
      path: `service ${action}`,
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} the user service.`,
      options: [],
    }),
  ),
  {
    path: "logs",
    summary: "Read structured service logs.",
    options: ["follow"],
  },
  {
    path: "providers list",
    summary: "List authorized providers and capabilities.",
    options: [],
  },
  {
    path: "providers models",
    summary: "Discover models from an authorized provider instance.",
    options: ["provider", "workspace"],
    required: ["provider", "workspace"],
  },
  {
    path: "threads configure",
    summary:
      "Save configuration for subsequent turns using a current thread version.",
    options: ["thread", "expected-version", "configuration"],
    required: ["thread", "expected-version", "configuration"],
  },
  {
    path: "events read",
    summary: "Read a bounded page of retained committed events after a cursor.",
    options: ["thread", "after", "limit"],
    required: ["thread", "after"],
  },
  {
    path: "interactions list",
    summary: "Inspect approvals, questions and application tool outcomes.",
    options: ["thread"],
    required: ["thread"],
  },
  {
    path: "tools list",
    summary: "Inspect the authorized tool manifest and endpoint availability.",
    options: ["thread"],
    required: ["thread"],
  },
  {
    path: "threads list",
    summary: "List owned execution threads.",
    options: [],
  },
  {
    path: "threads create",
    summary: "Create a provider-bound thread.",
    options: ["provider", "workspace", "private"],
    required: ["provider", "workspace"],
  },
  {
    path: "threads show",
    summary: "Read thread, turns, interactions and replay cursor.",
    options: ["thread"],
    required: ["thread"],
  },
  {
    path: "turns submit",
    summary: "Durably accept one turn with a stable command identity.",
    options: ["thread", "command", "text"],
    required: ["thread", "command", "text"],
  },
  {
    path: "turns show",
    summary: "Inspect execution and output completeness.",
    options: ["turn"],
    required: ["turn"],
  },
  {
    path: "turns resolve",
    summary:
      "Release uncertain work only after verifying the external agent stopped; never retries it.",
    options: ["turn", "outcome", "stopped"],
    required: ["turn", "outcome", "stopped"],
  },
  {
    path: "turns cancel",
    summary: "Request cancellation; inspect the eventual outcome.",
    options: ["turn"],
    required: ["turn"],
  },
  {
    path: "commands show",
    summary: "Resolve a lost command acknowledgement.",
    options: ["command"],
    required: ["command"],
  },
  {
    path: "events watch",
    summary: "Watch committed thread snapshots and events.",
    options: ["thread"],
    required: ["thread"],
  },
  {
    path: "interactions respond",
    summary: "Answer a live approval or structured question.",
    options: ["id", "response"],
    required: ["id", "response"],
  },
  {
    path: "context show",
    summary: "Inspect retained turn preparation and omissions.",
    options: ["turn"],
    required: ["turn"],
  },
  {
    path: "memory search",
    summary: "Search the thread's authorized memory scope.",
    options: ["thread", "query"],
    required: ["thread", "query"],
  },
  {
    path: "memory get",
    summary: "Read memory and its source evidence.",
    options: ["thread", "ref"],
    required: ["thread", "ref"],
  },
  {
    path: "token show",
    summary: "Explicitly reveal the configured client token.",
    options: [],
  },
];
export const GLOBAL_OPTIONS = [
  "config",
  "instance",
  "json",
  "no-input",
  "color",
  "help",
  "version",
];
const BOOLEAN_OPTIONS = new Set([
  "json",
  "no-input",
  "help",
  "version",
  "watch",
  "follow",
  "private",
  "stopped",
]);
export function parseArgs(argv: string[]) {
  const options: Record<string, string | boolean> = {};
  const path: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (!value.startsWith("--")) {
      path.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split(/=(.*)/s);
    if (BOOLEAN_OPTIONS.has(name!)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      options[name!] = true;
    } else {
      const next = inline ?? argv[++i];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`--${name} requires a value`);
      options[name!] = next;
    }
  }
  if (path[0] === "help") {
    path.shift();
    options.help = true;
  }
  const command = path.join(" ");
  const spec = COMMANDS.find((item) => item.path === command);
  const group =
    !command || COMMANDS.some((item) => item.path.startsWith(`${command} `));
  if (!spec && !group)
    throw new Error(`Unknown command ${command}. Use --help.`);
  for (const name of Object.keys(options))
    if (!GLOBAL_OPTIONS.includes(name) && !spec?.options.includes(name))
      throw new Error(`Unknown option --${name}. Use ${command} --help.`);
  if (
    options.color &&
    !["auto", "always", "never"].includes(String(options.color))
  )
    throw new Error("--color must be auto, always or never");
  if (!options.help && spec)
    for (const name of spec.required ?? [])
      if (options[name] === undefined)
        throw new Error(`${command} requires --${name}`);
  return { command, options, spec, help: options.help || !spec };
}
export function helpText(prefix = ""): string {
  const commands = COMMANDS.filter(
    (item) =>
      !prefix || item.path === prefix || item.path.startsWith(`${prefix} `),
  );
  return [
    `lapis-ai-controller ${prefix}`.trim(),
    "",
    "Durable AI execution, shared memory and service management.",
    "",
    ...commands.map(
      (item) =>
        `  ${item.path.padEnd(24)} ${item.summary}${item.required?.length ? ` Required: ${item.required.map((name) => `--${name}`).join(", ")}.` : ""}`,
    ),
    "",
    "Global: --config <path> --instance <name> --json --no-input --color <auto|always|never> --help --version",
  ].join("\n");
}
export function markdownHelp(): string {
  return `# Controller command reference\n\nGenerated from the command tree.\n\n${COMMANDS.map((command) => `## ${command.path}\n\n${command.summary}\n\nOptions: ${command.options.map((name) => `\`--${name}\``).join(", ") || "global options only"}.\n`).join("\n")}`;
}
