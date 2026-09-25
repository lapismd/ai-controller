import type { Interaction, Json } from "../contracts.js";
import { appendEvent } from "./store-events.js";
import type { StoreHost } from "./store-host.js";
import { readThread } from "./store-records.js";

export function putInteraction(
  host: StoreHost,
  interaction: Interaction,
): void {
  interaction = host.capture.clean(interaction, true);
  host.transaction(() => {
    const privatePayload =
      readThread(host, interaction.threadId)!.payloadPolicy === "metadata-only";
    host.db
      .prepare(
        "INSERT INTO interactions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(
        interaction.id,
        interaction.threadId,
        JSON.stringify(
          privatePayload
            ? { ...interaction, request: null, response: undefined }
            : interaction,
        ),
      );
    if (privatePayload)
      host.volatileInteractions.set(
        interaction.id,
        structuredClone(interaction),
      );
    appendEvent(
      host,
      interaction.threadId,
      "interaction.updated",
      interaction as unknown as Json,
      interaction.turnId,
    );
  });
}
