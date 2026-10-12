import { webcrypto } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export const TEST_PASSWORD = "test-Owner-password-1";

async function pbkdf2(password: string): Promise<string> {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  return `pbkdf2-sha256$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** A throwaway VAPID key pair in the installer's format (base64url public point and private scalar). */
async function vapidKeys(): Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  return { VAPID_PUBLIC_KEY: Buffer.from(raw).toString("base64url"), VAPID_PRIVATE_KEY: jwk.d! };
}

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TALORYS_ENV: "development",
          TALORYS_MOCK_AI: "1",
          TALORYS_DEV_ORIGINS: "",
          OWNER_PASSWORD_HASH: await pbkdf2(TEST_PASSWORD),
          SESSION_SECRET: "test-session-secret-0123456789abcdefghijklmnop",
          TEST_PASSWORD,
          ...(await vapidKeys()),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
}));
