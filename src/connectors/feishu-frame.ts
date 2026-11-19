/**
 * The frames Feishu's long connection speaks: protobuf messages named pbbp2.Frame, as defined in
 * Feishu's own SDKs. Only what that one message needs is implemented here.
 *
 *   message Header { string key = 1; string value = 2; }
 *   message Frame {
 *     uint64 SeqID = 1; uint64 LogID = 2; int32 service = 3; int32 method = 4;
 *     repeated Header headers = 5; string payload_encoding = 6; string payload_type = 7;
 *     bytes payload = 8; string LogIDNew = 9;
 *   }
 */

export interface Frame {
  seqId: bigint;
  logId: bigint;
  service: number;
  /** 0: control (ping, pong). 1: data (an event or a card callback). */
  method: number;
  headers: { key: string; value: string }[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  logIdNew?: string;
}

export const CONTROL = 0;
export const DATA = 1;

const text = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: false });

function varint(value: bigint, out: number[]): void {
  let v = BigInt.asUintN(64, value);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function field(out: number[], number: number, bytes: Uint8Array): void {
  varint(BigInt((number << 3) | 2), out);
  varint(BigInt(bytes.length), out);
  for (const b of bytes) out.push(b);
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  // The SDKs always write these four, even when zero.
  out.push(8);
  varint(frame.seqId, out);
  out.push(16);
  varint(frame.logId, out);
  out.push(24);
  varint(BigInt(frame.service), out);
  out.push(32);
  varint(BigInt(frame.method), out);
  for (const header of frame.headers) {
    const inner: number[] = [];
    field(inner, 1, text.encode(header.key));
    field(inner, 2, text.encode(header.value));
    field(out, 5, Uint8Array.from(inner));
  }
  if (frame.payloadEncoding !== undefined) field(out, 6, text.encode(frame.payloadEncoding));
  if (frame.payloadType !== undefined) field(out, 7, text.encode(frame.payloadType));
  if (frame.payload !== undefined) field(out, 8, frame.payload);
  if (frame.logIdNew !== undefined) field(out, 9, text.encode(frame.logIdNew));
  return Uint8Array.from(out);
}

/** Reads a frame. Throws on anything that is not well-formed; unknown fields are skipped. */
export function decodeFrame(bytes: Uint8Array): Frame {
  let at = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= bytes.length) throw new Error("frame ends inside a number");
      const byte = bytes[at++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("number is too long");
    }
  };
  const readBytes = (): Uint8Array => {
    const declared = readVarint();
    if (declared > BigInt(bytes.length - at)) throw new Error("frame ends inside a field");
    const length = Number(declared);
    const slice = bytes.subarray(at, at + length);
    at += length;
    return slice;
  };
  const frame: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] };
  while (at < bytes.length) {
    const tag = Number(readVarint());
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = readVarint();
      if (number === 1) frame.seqId = value;
      else if (number === 2) frame.logId = value;
      else if (number === 3) frame.service = Number(BigInt.asIntN(32, value));
      else if (number === 4) frame.method = Number(BigInt.asIntN(32, value));
    } else if (wire === 2) {
      const value = readBytes();
      if (number === 5) frame.headers.push(decodeHeader(value));
      else if (number === 6) frame.payloadEncoding = utf8.decode(value);
      else if (number === 7) frame.payloadType = utf8.decode(value);
      else if (number === 8) frame.payload = value.slice();
      else if (number === 9) frame.logIdNew = utf8.decode(value);
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    if (at > bytes.length) throw new Error("frame ends inside a field");
  }
  return frame;
}

function decodeHeader(bytes: Uint8Array): { key: string; value: string } {
  const header = { key: "", value: "" };
  let at = 0;
  // Lengths are read as plain non-negative numbers and checked against what is left; nothing here
  // uses 32-bit arithmetic that could turn a large length negative.
  const number = (): number => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      if (at >= bytes.length) throw new Error("header ends inside a number");
      const byte = bytes[at++];
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error("header number is too long");
  };
  while (at < bytes.length) {
    const tag = number();
    if ((tag & 7) !== 2) throw new Error("malformed header");
    const length = number();
    if (length > bytes.length - at) throw new Error("header ends inside a field");
    const value = utf8.decode(bytes.subarray(at, at + length));
    at += length;
    if (tag >>> 3 === 1) header.key = value;
    else if (tag >>> 3 === 2) header.value = value;
  }
  return header;
}

export function headerOf(frame: Frame, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value;
}
