import { describe, expect, it } from "vitest";
import { OpenTrackedClient } from "../src/openTracked.js";
import { redact } from "../src/tools.js";

const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("OpenTrackedClient", () => {
  it("sends the bearer token and unwraps data", async () => {
    let seen: any;
    const c = new OpenTrackedClient("https://app.example.com/", "tok", async (url, init) => {
      seen = { url, init };
      return reply(200, { success: true, data: { score: 40 } })();
    });
    expect(await c.get("/containers/1/tracking-score")).toEqual({ score: 40 });
    expect(seen.url).toBe("https://app.example.com/api/v1/containers/1/tracking-score");
    expect(seen.init.headers.Authorization).toBe("Bearer tok");
  });

  it("explains a missing token and a refused one", async () => {
    await expect(new OpenTrackedClient("https://x.io", undefined).get("/a")).rejects.toThrow(/OPEN_TRACKED_TOKEN/);
    await expect(new OpenTrackedClient("https://x.io", "t", reply(401, { message: "Unauthenticated." })).get("/a")).rejects.toThrow(/wrong or was removed/);
    await expect(new OpenTrackedClient("https://x.io", "t", reply(404, { message: "nope" })).get("/a")).rejects.toThrow(/not yours/);
  });
});

describe("redact", () => {
  it("keeps the API key and billing ids out of the conversation", () => {
    expect(redact({ id: 1, api_key: "secret", paddle_customer_id: "ctm_1", domains: [{ domain: "a.com", settings: { x: 1 } }] })).toEqual({ id: 1, domains: [{ domain: "a.com" }] });
  });
});
