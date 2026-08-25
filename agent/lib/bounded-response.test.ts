import { describe, expect, it } from "vitest";
import { readResponseTextLimited } from "./bounded-response.js";

describe("bounded response reads", () => {
  it("returns text within the byte limit", async () => {
    await expect(readResponseTextLimited(new Response("hello"), 5)).resolves.toBe("hello");
  });

  it("rejects a declared oversized response before reading it", async () => {
    const response = new Response("ignored", { headers: { "content-length": "501" } });
    await expect(readResponseTextLimited(response, 500)).rejects.toThrow("500 byte limit");
  });

  it("stops a streamed response when chunks exceed the limit", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }));
    await expect(readResponseTextLimited(response, 5)).rejects.toThrow("5 byte limit");
  });
});
