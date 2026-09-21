import { describe, expect, it } from "vitest";
import { rejectedRequestedConfiguration } from "./acp-configure.js";

describe("ACP requested configuration", () => {
  it("ignores host-invented unsupported thinking when thinking was not requested", () => {
    expect(
      rejectedRequestedConfiguration(
        { model: "auto" },
        {
          model: { status: "applied" },
          thinking: { status: "unsupported" },
        },
      ),
    ).toBeUndefined();
  });

  it("rejects only the requested unsupported field", () => {
    expect(
      rejectedRequestedConfiguration(
        { thinking: "medium" },
        {
          thinking: {
            status: "unsupported",
            reason: "The ACP session does not advertise thinking configuration.",
          },
        },
      ),
    ).toEqual({
      field: "thinking",
      reason: "The ACP session does not advertise thinking configuration.",
    });
  });
});
