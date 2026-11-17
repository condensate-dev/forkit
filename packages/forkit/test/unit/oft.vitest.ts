/** LayerZero OFT, the parts that need no chain: the OFTSent topic and the packet layout. */
import { concat, numberToHex, pad, toEventSelector } from "viem";
import { describe, expect, test } from "vitest";
import { decodeOftPacket, OftError, oftSentEvent } from "../../src/bridges/index.ts";

const oft = "0x00000000000000000000000000000000000000f7";
const bob = "0x0000000000000000000000000000000000000B0b";
const guid = `0x${"ab".repeat(32)}` as const;

// PacketV1Codec: version, nonce, srcEid, sender, dstEid, receiver, guid, then the message.
const packet = (message: `0x${string}`) =>
  concat([
    "0x01",
    numberToHex(7n, { size: 8 }),
    numberToHex(30_184, { size: 4 }),
    pad(oft),
    numberToHex(30_111, { size: 4 }),
    pad(oft),
    guid,
    message,
  ]);

describe("LayerZero OFT", () => {
  test("OFTSent has the topic OFTs emit on Base", () => {
    // topic0 of live Base logs.
    expect(toEventSelector(oftSentEvent)).toBe(
      "0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a",
    );
  });

  test("decodes the header and a plain OFT message", () => {
    expect(decodeOftPacket(packet(concat([pad(bob), numberToHex(5n, { size: 8 })])))).toMatchObject(
      {
        nonce: 7n,
        srcEid: 30_184,
        dstEid: 30_111,
        receiver: oft,
        guid,
        sendTo: bob,
        amountSD: 5n,
      },
    );
  });

  test("keeps the compose part of a composed message", () => {
    const compose = concat([pad(bob), "0xbeef"]);
    const decoded = decodeOftPacket(
      packet(concat([pad(bob), numberToHex(5n, { size: 8 }), compose])),
    );
    expect(decoded.compose).toBe(compose);
  });

  test("refuses a packet too short for an OFT message, and a non-EVM recipient", () => {
    expect(() => decodeOftPacket(packet("0x1234"))).toThrow(OftError);
    expect(() =>
      decodeOftPacket(packet(concat([`0x${"11".repeat(32)}`, numberToHex(5n, { size: 8 })]))),
    ).toThrow(/sendTo .* is not an EVM address/);
  });
});
