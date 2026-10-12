import { concat, pointToJwk } from "./encoding";

/** Record size advertised in the aes128gcm header. One record always holds a push payload. */
const RECORD_SIZE = 4096;
const encoder = new TextEncoder();

/** The sending side's one-off key pair and salt; injectable so tests can replay the RFC 8291 vector. */
export interface EphemeralKeys {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  salt: Uint8Array;
}

export async function newEphemeralKeys(): Promise<EphemeralKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKey, salt: crypto.getRandomValues(new Uint8Array(16)) };
}

/** Imports a known ECDH private key (tests only replay fixed vectors this way). */
export async function importEphemeral(publicKey: Uint8Array, d: Uint8Array, salt: Uint8Array): Promise<EphemeralKeys> {
  const privateKey = await crypto.subtle.importKey("jwk", pointToJwk(publicKey, d), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey, publicKey, salt };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypts a push message body for one subscription (RFC 8291, "aes128gcm" content coding
 * from RFC 8188). Only the browser holding the subscription's private key can read it;
 * the push service relaying it sees ciphertext.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscriber: { p256dh: Uint8Array; auth: Uint8Array },
  keys?: EphemeralKeys,
): Promise<Uint8Array<ArrayBuffer>> {
  const eph = keys ?? (await newEphemeralKeys());
  const uaPublic = await crypto.subtle.importKey("raw", subscriber.p256dh as Uint8Array<ArrayBuffer>, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The runtime reads the standard `public` field; workers-types spells it `$public`.
  const ecdh = { name: "ECDH", public: uaPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, eph.privateKey, 256));
  const keyInfo = concat(encoder.encode("WebPush: info\0"), subscriber.p256dh, eph.publicKey);
  const ikm = await hkdf(subscriber.auth, shared, keyInfo, 32);
  const cek = await hkdf(eph.salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(eph.salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // A single, final record: the plaintext followed by the 0x02 delimiter and no padding.
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(eph.salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = eph.publicKey.length;
  return concat(header, eph.publicKey, ciphertext);
}
