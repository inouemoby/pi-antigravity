import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: true,
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@cortexkit/antigravity-auth-core"
  ]
});
