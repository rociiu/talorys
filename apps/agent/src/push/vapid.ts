import { b64url, fromB64url, pointToJwk } from "./encoding";

/** Server identity for Web Push (RFC 8292): a P-256 key pair the installer generates. */
export interface VapidKeys {
  /** Uncompressed public key, base64url; browsers subscribe with it as applicationServerKey. */
  publicKey: string;
  signingKey: CryptoKey;
}

/** JWTs are valid for 12 hours; push services reject anything over 24. */
const TOKEN_LIFETIME_S = 12 * 3600;

/** Imports the key pair from its usual text form (base64url public point and private scalar). Null if either is unusable. */
export async function importVapidKeys(publicKey: string | undefined, privateKey: string | undefined): Promise<VapidKeys | null> {
  if (!publicKey || !privateKey) return null;
  try {
    const jwk = pointToJwk(fromB64url(publicKey), fromB64url(privateKey));
    const signingKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return { publicKey, signingKey };
  } catch {
    return null;
  }
}

/**
 * The Authorization header value for one push request: a short-lived ES256 JWT scoped to the
 * push service's origin, plus the public key it verifies against.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowS + TOKEN_LIFETIME_S, sub: subject })));
  const input = enc.encode(`${header}.${claims}`);
  // Web Crypto returns ECDSA signatures as raw r || s, which is exactly the JWS ES256 form.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.signingKey, input);
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

