// Pre-build the dashboard into dist/dashboard with Tailwind compiled.
// Run via `bun run build:dashboard` in the source tree and COMMIT the output:
// production serving reads these static files. A global install lives under
// node_modules, where bun-plugin-tailwind skips compilation — so we cannot
// build on install. (Bun's dev-server `[serve.static].plugins` config also
// does not apply to programmatic Bun.serve() HTML routes.)
import tailwind from "bun-plugin-tailwind";
import { rmSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "dist/dashboard");
rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [resolve(root, "src/dashboard/index.html")],
  outdir,
  plugins: [tailwind],
  minify: true,
  sourcemap: "none",
  publicPath: "/dashboard/",
  naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});

if (!result.success) {
  console.error("dashboard build failed:");
  for (const m of result.logs) console.error(String(m));
  process.exit(1);
}
console.log(`dashboard built -> ${outdir}`);
for (const o of result.outputs) console.log("  ", o.path.replace(root + "/", ""), `(${o.kind})`);
