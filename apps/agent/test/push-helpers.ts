import { b64url, concat } from "../src/push/encoding";

/** A browser-side push subscription: its ECDH key pair and auth secret, as a real browser would hold them. */
export async function fakeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint,
    p256dh,
    auth,
    privateKey: pair.privateKey,
    json: { endpoint, keys: { p256dh: b64url(p256dh), auth: b64url(auth) } },
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: infoBytes as Uint8Array<ArrayBuffer> }, key, bytes * 8),
  );
}

/** Decrypts an aes128gcm push body the way the receiving browser does (RFC 8291), to check what was sent. */
export async function decryptAsBrowser(body: Uint8Array, browser: Awaited<ReturnType<typeof fakeBrowser>>): Promise<unknown> {
  const salt = body.slice(0, 16);
  const idLen = body[20]!;
  const asPublic = body.slice(21, 21 + idLen);
  const serverKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = { name: "ECDH", public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, browser.privateKey, 256));
  const ikm = await hkdf(browser.auth, shared, concat(new TextEncoder().encode("WebPush: info\0"), browser.p256dh, asPublic), 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idLen)));
  if (record[record.length - 1] !== 2) throw new Error("missing final-record delimiter");
  return JSON.parse(new TextDecoder().decode(record.slice(0, -1)));
}

export interface CapturedPush {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A fetch stand-in for push services: records each request and answers with `status`. */
export function pushServiceStub(status: number | (() => number) = 201) {
  const sent: CapturedPush[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    sent.push({ url: String(input), headers, body: new Uint8Array(init?.body as Uint8Array) });
    return new Response(null, { status: typeof status === "function" ? status() : status });
  }) as typeof fetch;
  return { sent, fetcher };
}
