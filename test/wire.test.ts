import { describe, expect, it } from "vitest";
import {
  Decoder,
  HEADER_LEN,
  Kind,
  MAX_PAYLOAD,
  WireError,
  decodeFrame,
  encodeFrame,
  eofFrame,
  frame,
  jsonFrame,
  negotiate,
  parseJson,
  requestFrame,
} from "../src/wire.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("frames", () => {
  it("match the layout in pyo-proto", () => {
    // The same vector as pyo_proto::sandbox::wire::tests::frame_layout_is_fixed.
    const f = frame(Kind.Stdout, 7, bytes("hi"));
    expect([...encodeFrame(f)]).toEqual([0, 0, 0, 7, 5, 0, 0, 0, 7, 104, 105]);
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
    expect(encodeFrame(eofFrame(3)).length).toBe(HEADER_LEN);
  });

  it("use big-endian stream numbers up to u32", () => {
    const f = frame(Kind.Stdin, 0xfedcba98, bytes("x"));
    const enc = encodeFrame(f);
    expect([...enc.subarray(5, 9)]).toEqual([0xfe, 0xdc, 0xba, 0x98]);
    expect(decodeFrame(enc).stream).toBe(0xfedcba98);
    expect(() => encodeFrame(frame(Kind.Stdin, -1))).toThrow(WireError);
  });

  it("carry the largest payload", () => {
    const f = frame(Kind.Stdin, 1, new Uint8Array(MAX_PAYLOAD));
    expect(decodeFrame(encodeFrame(f)).payload.length).toBe(MAX_PAYLOAD);
    expect(() => encodeFrame(frame(Kind.Stdin, 1, new Uint8Array(MAX_PAYLOAD + 1)))).toThrow(/over the limit/);
  });

  it("decode from split bytes", () => {
    const a = encodeFrame(frame(Kind.Stdout, 1, bytes("abc")));
    const b = encodeFrame(frame(Kind.Stderr, 2, bytes("de")));
    const all = new Uint8Array([...a, ...b]);
    const d = new Decoder();
    const got = [];
    for (const byte of all) {
      d.push(new Uint8Array([byte]));
      for (let f = d.next(); f; f = d.next()) got.push(f);
    }
    expect(got).toHaveLength(2);
    expect(new TextDecoder().decode(got[1]!.payload)).toBe("de");
    expect(got[1]!.kind).toBe(Kind.Stderr);
    expect(d.isEmpty()).toBe(true);
  });

  it("refuse bad frames", () => {
    const big = new Uint8Array(9);
    new DataView(big.buffer).setUint32(0, MAX_PAYLOAD + 6);
    big.set([5, 0, 0, 0, 1], 4);
    expect(() => decodeFrame(big)).toThrow(/over the limit/);
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 5, 99, 0, 0, 0, 1]))).toThrow(/unknown frame kind 99/);
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 9, 5, 0, 0, 0, 1]))).toThrow(/cut short/);
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 2, 5]))).toThrow(/cut short/);
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 4, 5, 0, 0, 0, 1]))).toThrow(/cut short/);
    expect(() => decodeFrame(new Uint8Array([...encodeFrame(eofFrame(1)), 0]))).toThrow(/after the frame/);
  });
});

describe("messages", () => {
  it("serialize requests like serde does", () => {
    const f = requestFrame(1, { op: "writeFile", path: "/a", mode: 0o600, append: false });
    expect(f.kind).toBe(Kind.Request);
    expect(parseJson(f)).toEqual({ op: "writeFile", path: "/a", mode: 384, append: false });
    expect(parseJson(requestFrame(2, { op: "exec", cmd: ["ls", "-l"], env: {}, stdin: false }))).toEqual({
      op: "exec",
      cmd: ["ls", "-l"],
      env: {},
      stdin: false,
    });
    expect(parseJson(jsonFrame(Kind.Response, 1, { type: "exit", code: 3 }))).toEqual({ type: "exit", code: 3 });
  });
});

describe("negotiate", () => {
  it("picks the newest version both sides speak", () => {
    expect(negotiate({ protocol: 1, minProtocol: 1, envdVersion: "x" })).toBe(1);
    expect(negotiate({ protocol: 4, minProtocol: 1, envdVersion: "x" })).toBe(1);
  });

  it("fails without a common version", () => {
    expect(() => negotiate({ protocol: 4, minProtocol: 2, envdVersion: "9.9.9" })).toThrow(/envd 9.9.9 speaks protocol 2 to 4/);
    expect(() => negotiate({ protocol: 0, minProtocol: 0, envdVersion: "x" })).toThrow(WireError);
  });
});
