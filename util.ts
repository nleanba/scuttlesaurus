import sodium, {
  base64_variants as base64Variants,
} from "https://deno.land/x/sodium@0.2.0/sumo.ts";
export * as path from "https://deno.land/std@0.103.0/path/mod.ts";
export * as log from "https://deno.land/std@0.103.0/log/mod.ts";
export { delay } from "https://deno.land/std@0.103.0/async/mod.ts";

const textEncoder = new TextEncoder();

export function parseAddress(addr: string) {
  const sections = addr.split(":");
  const [protocol, host, portshs, key] = sections;
  const port = parseInt(portshs.split("~")[0]);
  return { protocol, host, port, key };
}

export function bytes2NumberUnsigned(bytes: Uint8Array): number {
  return bytes.length === 0 ? 0 : bytes[0] * Math.pow(0x100, bytes.length - 1) +
    bytes2NumberUnsigned(bytes.subarray(1));
}

export function bytes2NumberSigned(bytes: Uint8Array): number {
  return bytes[0] & 0b10000000
    ? -Math.pow(2, 7 + (bytes.length - 1) * 8) + (0b01111111 &
          bytes[0]) * Math.pow(0x100, bytes.length - 1) +
      bytes2NumberUnsigned(bytes.subarray(1))
    : bytes2NumberUnsigned(bytes);
}

export function concat(...elems: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    elems.reduce((sum, elem) => sum + (elem.length), 0),
  );
  let pos = 0;
  for (const elem of elems) {
    result.set(elem, pos);
    pos += elem.length;
  }
  return result;
}

export async function readBytes(reader: Deno.Reader, length: number) {
  const result = new Uint8Array(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const remainder = result.subarray(bytesRead);
    try {
      const bytesReadNow = await reader.read(remainder);
      if (bytesReadNow === null) {
        throw new Error(
          `End of reader, expecting ${remainder.length} more bytes`,
        );
      }
      bytesRead += bytesReadNow;
    } catch (e) {
      throw e;
    }
  }
  return result;
}
/** convert base64 from standard to filename-safe alphabet */
export const filenameSafeAlphabetRFC3548 = (orig: string) =>
  orig.replaceAll("/", "_").replaceAll("+", "-");

export function toBase64(data: Uint8Array) {
  return sodium.to_base64(
    data,
    base64Variants.ORIGINAL_NO_PADDING,
  );
}

export function fromBase64(text: string) {
  return sodium.from_base64(
    text,
    base64Variants.ORIGINAL_NO_PADDING,
  );
}

function nodeBinaryEncode(text: string): Uint8Array {
  function encodeValue(value: number) {
    if (value <= 0xFFFF) {
      return new Uint8Array([value & 0xFF]);
    } else {
      const firstByte = (Math.floor(value / 0x400) - 0b1000000) & 0xFF;
      const secondByte = value & 0xFF;
      return new Uint8Array([firstByte, secondByte]);
    }
  }

  function encodeChars(chars: number[]): Uint8Array {
    if (chars.length === 0) {
      return new Uint8Array(0);
    } else {
      return concat(...chars.map((char) => encodeValue(char)));
    }
  }
  const codePoints: number[] = [...text].map((cp) => cp.codePointAt(0)!);
  return encodeChars(codePoints);
}

export function computeMsgHash(msg: unknown) {
  return sodium.crypto_hash_sha256(
    nodeBinaryEncode(JSON.stringify(msg, undefined, 2)),
  );
}

/*export function signMessage(msg: unknown): Record<string, unknown> {
  return sodium.crypto_hash_sha256(textEncoder.encode(JSON.stringify(msg, undefined, 2)))
}*/

export function verifySignature(msg: { author: string; signature?: string }) {
  if (!msg.signature) {
    throw Error("no signature in messages");
  }
  const signatureString = msg.signature;
  const signature = fromBase64(
    signatureString.substring(
      0,
      signatureString.length - ".sig.ed25519".length,
    ),
  );
  const authorsPubkicKey = fromBase64(
    msg.author.substring(1, msg.author.length - ".ed25519".length),
  );
  delete msg.signature;
  const verifyResult = sodium.crypto_sign_verify_detached(
    signature,
    textEncoder.encode(JSON.stringify(msg, undefined, 2)),
    authorsPubkicKey,
  );
  msg.signature = signatureString;
  return verifyResult;
}

export function isZero(bytes: Uint8Array) {
  return !bytes.find((b) => b > 0);
}
