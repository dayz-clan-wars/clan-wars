import { describe, it, expect, vi } from "vitest";
import { createFeedPoster } from "../src/discord.js";

const embed = { title: "Bears [BEAR]" };

describe("createFeedPoster", () => {
  it("posts the embed to the configured channel", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = { channels: { fetch: vi.fn().mockResolvedValue({ isSendable: () => true, send }) } };

    await createFeedPoster(client as never, "123")(embed);

    expect(client.channels.fetch).toHaveBeenCalledWith("123");
    expect(send).toHaveBeenCalledWith({ embeds: [embed] });
  });

  it("⚠️ throws when the channel is missing, so the row stays queued", async () => {
    // Swallowing here would mark the row posted and lose the announcement
    // permanently — the exact hole the retry design exists to prevent.
    const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } };
    await expect(createFeedPoster(client as never, "123")(embed)).rejects.toThrow(/123/u);
  });

  it("throws when the channel cannot be sent to", async () => {
    const client = { channels: { fetch: vi.fn().mockResolvedValue({ isSendable: () => false }) } };
    await expect(createFeedPoster(client as never, "123")(embed)).rejects.toThrow(/123/u);
  });

  it("propagates a send failure rather than reporting success", async () => {
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ isSendable: () => true, send: vi.fn().mockRejectedValue(new Error("missing Embed Links")) }) },
    };
    await expect(createFeedPoster(client as never, "123")(embed)).rejects.toThrow(/Embed Links/u);
  });
});
