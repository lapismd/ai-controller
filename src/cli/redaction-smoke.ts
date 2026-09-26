import { SynchronousRedaction } from "@lapismd/agent-redaction/node";
export function runRedactionSmoke(): void {
  const scanner = new SynchronousRedaction();
  try {
    const result = scanner.text("controller installation worker check");
    if (result.status !== "sanitized")
      throw new Error("Redaction worker could not sanitize input");
    console.log(
      JSON.stringify({
        schema: "lapis-ai-controller.redaction-smoke/1",
        status: result.status,
      }),
    );
  } finally {
    scanner.dispose();
  }
}
