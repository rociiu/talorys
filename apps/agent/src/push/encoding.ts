/** Base64url without padding, as used by Web Push keys, VAPID and JWTs. */
export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (padding optional). Throws on characters outside the alphabet. */
export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error("Invalid base64url");
  const bin = atob(text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A P-256 public key in uncompressed form (0x04 || x || y) as a JWK, for importing private keys. */
export function pointToJwk(point: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (point.length !== 65 || point[0] !== 4) throw new Error("Expected an uncompressed P-256 public key");
  return {
    kty: "EC",
    crv: "P-256",
    x: b64url(point.slice(1, 33)),
    y: b64url(point.slice(33, 65)),
    ...(d ? { d: b64url(d) } : {}),
  };
}
