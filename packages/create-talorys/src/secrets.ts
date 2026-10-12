import { randomBytes, webcrypto } from "node:crypto";
import { hashPassword } from "@talorys/shared/crypto";
import { checkPasswordStrength } from "@talorys/shared/password-policy";

export const PASSWORD_SECRET = "OWNER_PASSWORD_HASH";
export const SESSION_SECRET = "SESSION_SECRET";
export const REQUIRED_SECRETS = [PASSWORD_SECRET, SESSION_SECRET] as const;
/** Web Push (VAPID) key pair. Optional: without it the app works, only push notifications are off. */
export const PUSH_SECRETS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

export function validatePassword(password: string | undefined): string | undefined {
  if (!password) return "Please enter a password.";
  return checkPasswordStrength(password) ?? undefined;
}

/** 256-bit random session key, base64url encoded. */
export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Builds the secret payload. The plaintext password is hashed locally with
 * PBKDF2-SHA256 and never leaves this machine.
 */
export async function buildOwnerSecrets(password: string, opts: { includeSessionSecret: boolean }): Promise<Record<string, string>> {
  const secrets: Record<string, string> = { [PASSWORD_SECRET]: await hashPassword(password) };
  if (opts.includeSessionSecret) secrets[SESSION_SECRET] = generateSessionSecret();
  return secrets;
}

/**
 * A fresh P-256 key pair for Web Push, in the usual text form: the base64url uncompressed
 * public point and private scalar (the same format as `npx web-push generate-vapid-keys`).
 */
export async function generatePushKeys(): Promise<Record<(typeof PUSH_SECRETS)[number], string>> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
  const { d } = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  if (!d) throw new Error("Key generation did not return a private key");
  return { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: d };
}
