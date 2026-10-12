import { describe, expect, it } from "vitest";
import { b64url, fromB64url, pointToJwk } from "../src/push/encoding";
import { encryptPayload, importEphemeral } from "../src/push/ece";
import { importVapidKeys, vapidAuthorization } from "../src/push/vapid";

// RFC 8291 section 5 ("Push Message Encryption Example"), every value verbatim.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("Web Push message encryption (RFC 8291)", () => {
  it("reproduces the RFC 8291 example byte for byte", async () => {
    const keys = await importEphemeral(fromB64url(RFC.asPublic), fromB64url(RFC.asPrivate), fromB64url(RFC.salt));
    const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), { p256dh: fromB64url(RFC.uaPublic), auth: fromB64url(RFC.auth) }, keys);
    expect(b64url(body)).toBe(RFC.body);
  });

  it("uses a fresh key and salt for every message", async () => {
    const sub = { p256dh: fromB64url(RFC.uaPublic), auth: fromB64url(RFC.auth) };
    const msg = new TextEncoder().encode("same text");
    const [a, b] = await Promise.all([encryptPayload(msg, sub), encryptPayload(msg, sub)]);
    expect(b64url(a)).not.toBe(b64url(b));
    // Header: 16-byte salt, record size 4096, key length 65, then the key.
    expect(new DataView(a.buffer).getUint32(16)).toBe(4096);
    expect(a[20]).toBe(65);
    expect(a.length).toBe(21 + 65 + msg.length + 1 + 16);
  });
});

describe("VAPID (RFC 8292)", () => {
  async function keyPair() {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const publicKey = b64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    return { publicKey, privateKey: jwk.d!, verifyKey: pair.publicKey };
  }

  it("signs an ES256 JWT scoped to the push service origin", async () => {
    const k = await keyPair();
    const vapid = await importVapidKeys(k.publicKey, k.privateKey);
    expect(vapid).not.toBeNull();
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid!, "https://me.pages.dev", 1_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, sig, key] = match!;
    expect(key).toBe(k.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c!)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_000_000 + 12 * 3600,
      sub: "https://me.pages.dev",
    });
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, k.verifyKey, fromB64url(sig!), new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });

  it("treats missing or malformed keys as push being unavailable", async () => {
    const k = await keyPair();
    expect(await importVapidKeys(undefined, k.privateKey)).toBeNull();
    expect(await importVapidKeys(k.publicKey, "not base64!")).toBeNull();
    expect(await importVapidKeys(k.publicKey.slice(0, 20), k.privateKey)).toBeNull();
    expect(() => pointToJwk(new Uint8Array(64))).toThrow();
  });
});
