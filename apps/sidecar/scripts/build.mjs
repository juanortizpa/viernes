// Bundles the sidecar and all workspace packages into one self-contained ESM file.
// `node:sqlite` is loaded at runtime through createRequire, so nothing native is bundled.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildSidecar(outfile = join(root, "dist/sidecar.mjs")) {
  await build({
    entryPoints: [join(root, "src/main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    legalComments: "none",
    // CJS dependencies pulled into an ESM bundle need require().
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("built", await buildSidecar());
}
