import { describe, expect, it } from "vitest";
import { CONTROL, DATA, decodeFrame, encodeFrame, headerOf } from "../src/connectors/feishu-frame";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

describe("Feishu long-connection frames", () => {
  it("writes a ping exactly as the protocol's own encoder would", () => {
    // Worked out by hand from the message definition: fields 1-4 as varints, then one header.
    const ping = encodeFrame({ seqId: 0n, logId: 0n, service: 1, method: CONTROL, headers: [{ key: "type", value: "ping" }] });
    expect(hex(ping)).toBe("08 00 10 00 18 01 20 00 2a 0c 0a 04 74 79 70 65 12 04 70 69 6e 67");
  });

  it("reads back what it writes, including ids beyond 53 bits and a binary payload", () => {
    const frame = {
      seqId: 18446744073709551615n,
      logId: 9007199254740993n,
      service: 33554678,
      method: DATA,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "消息-1" },
        { key: "sum", value: "1" },
      ],
      payloadEncoding: "gzip",
      payloadType: "json",
      payload: new Uint8Array([0, 255, 1, 128, 10]),
      logIdNew: "abc",
    };
    const back = decodeFrame(encodeFrame(frame));
    expect(back).toEqual(frame);
    expect(headerOf(back, "message_id")).toBe("消息-1");
    expect(headerOf(back, "absent")).toBeUndefined();
  });

  it("skips fields it does not know and refuses a frame that is cut short", () => {
    const known = encodeFrame({ seqId: 1n, logId: 2n, service: 3, method: DATA, headers: [{ key: "type", value: "card" }], payload: new TextEncoder().encode("{}") });
    // Field 15 as a varint, and field 16 as bytes, appended by some later version of the protocol.
    const extended = Uint8Array.from([...known, 0x78, 0x2a, 0x82, 0x01, 0x02, 0xaa, 0xbb]);
    expect(decodeFrame(extended)).toMatchObject({ seqId: 1n, service: 3, method: DATA });
    expect(() => decodeFrame(known.subarray(0, known.length - 1))).toThrow();
    expect(() => decodeFrame(Uint8Array.from([0x08]))).toThrow();
  });
});
