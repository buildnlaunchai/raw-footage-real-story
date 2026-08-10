// tsc emits the extensionless relative imports our source uses (Vite resolves
// them); Node's ESM loader will not. This rewrites them in the test build only,
// so the source stays as the app expects and tests run with no bundler.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../.test-build/", import.meta.url));

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".js")) yield p;
  }
}

for await (const file of walk(root)) {
  const src = await readFile(file, "utf8");
  const out = src.replace(/from "(\.\.?\/[^"]+)"/g, (m, spec) =>
    spec.endsWith(".js") ? m : `from "${spec}.js"`,
  );
  if (out !== src) await writeFile(file, out);
}
