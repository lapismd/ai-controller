import {
  defineConfig,
  singleIdVerification,
  tableRequirements,
} from "@lapismd/spec-validator";
export default defineConfig(tableRequirements(), {
  name: "ai-controller",
  idPattern: /^AIC-[A-Z]+-\d{3}$/,
  tableSection: "Requirements",
  ruleIds: {
    summary: "AIC-GOV-001",
    governance: "AIC-GOV-003",
    verification: "AIC-GOV-003",
    book: "AIC-GOV-001",
    bookIgnore: "AIC-GOV-001",
    specFirst: "AIC-GOV-002",
    internal: "AIC-GOV-003",
  },
  validators: {
    summary: true,
    governance: {
      extras: ["AGENTS.md", "README.md"],
      normative: true,
      proseLimits: true,
      acceptance: false,
      references: true,
      changeMap: true,
    },
    verification: singleIdVerification({
      headers: {
        ids: ["ID"],
        status: ["Status"],
        evidence: ["Evidence"],
        required: [],
      },
      statuses: ["Implemented", "Planned"],
    }),
    book: true,
    specFirst: {
      mode: "mapped",
      canonicalPattern: "^spec/src/(?:architecture|spec-governance)\\.md$",
      ignore: ["(^|/)node_modules/", "^dist/", "^spec/book/", "\\.test\\.ts$"],
      protected: [
        "^(?:src/|scripts/|docs/|package\\.json$|deno\\.json$|AGENTS\\.md$|spec-validator\\.config\\.mjs$|spec/book\\.toml$|\\.gitignore$)",
      ],
      rules: [
        {
          pattern: "^(?:src/|scripts/|docs/|package\\.json$|deno\\.json$)",
          chapters: ["spec/src/architecture.md"],
        },
        {
          pattern:
            "^(?:AGENTS\\.md$|spec-validator\\.config\\.mjs$|spec/book\\.toml$|\\.gitignore$)",
          chapters: ["spec/src/spec-governance.md"],
        },
      ],
    },
  },
  check: {
    lanes: [
      {
        name: "architecture",
        command: "node",
        args: ["scripts/check-architecture.mjs"],
      },
    ],
    build: true,
    first: true,
  },
});
