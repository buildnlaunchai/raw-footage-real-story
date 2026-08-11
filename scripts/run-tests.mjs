/**
 * Find the test files and run them.
 *
 * `node --test "tests/**\/*.test.mjs"` only works on Node versions whose test
 * runner expands globs itself; older ones take the pattern as a literal path
 * and report the glob as a missing file. Shell expansion is not a way out
 * either — npm scripts run under cmd.exe on Windows, which does not glob.
 *
 * So the list is built here, where neither the Node version nor the shell has
 * an opinion.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../tests/", import.meta.url));

function collect(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return collect(p);
    return name.endsWith(".test.mjs") ? [p] : [];
  });
}

const files = collect(root).sort();
if (files.length === 0) {
  console.error(`No test files under ${root}`);
  process.exit(1);
}

console.log(`running ${files.length} test files`);
const { status } = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
process.exit(status ?? 1);
