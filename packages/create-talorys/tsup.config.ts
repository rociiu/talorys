import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  // Shared code (password policy and hashing) is bundled; runtime deps stay external.
  noExternal: ["@talorys/shared"],
  external: ["@clack/prompts", "cf"],
  banner: { js: "#!/usr/bin/env node" },
});
