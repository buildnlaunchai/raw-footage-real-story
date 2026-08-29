/**
 * Did the release actually reach the people it was for?
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Publishing has a manual step and no failure mode. The workflow builds on a
 * `v*` tag and creates a DRAFT release on this repo; the hub reads a different,
 * public repo — `raw-footage-real-story-releases` — and the assets are copied
 * across by hand. v0.3.0's two releases are seven minutes apart, which is what
 * that looks like from outside.
 *
 * Skip the copy and nothing anywhere complains. The build is green, the tag
 * exists, the source release is published, and the hub goes on advertising the
 * previous version indefinitely. There is no error to notice, and "nobody
 * downloaded it" looks identical to "nobody could".
 *
 * So: after the manual step, an automatic check.
 *
 *     npm run verify:release
 *
 * The expected version comes from package.json rather than an argument, so this
 * cannot be run against a number somebody typed from memory.
 *
 * ─── LAG IS NOT FAILURE, AND THEY ARE REPORTED APART ────────────────────────
 *
 * The hub's page is ISR with a one-hour revalidate. So `releases/latest`
 * answering 0.4.0 while the page still shows 0.3.0 is a cache that has not
 * turned over yet — not a broken release. Reported as WAIT rather than FAIL,
 * because a check that cries wolf about a cache is a check people stop running.
 */
import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const TAG = `v${VERSION}`;
const SOURCE = "buildnlaunchai/raw-footage-real-story";
const PUBLIC = "buildnlaunchai/raw-footage-real-story-releases";
const PAGE = "https://www.buildnlaunchai.com/tools/raw-footage-real-story";
const CONFIG = "https://pezsxoynjjsipfnpfvva.supabase.co/functions/v1/desktop-config";

let pass = 0, fail = 0, wait = 0;
const ok = (l, d = "") => { console.log(`  PASS  ${l}${d ? `  — ${d}` : ""}`); pass++; };
const no = (l, d = "") => { console.log(`  FAIL  ${l}${d ? `  — ${d}` : ""}`); fail++; };
const soon = (l, d = "") => { console.log(`  WAIT  ${l}${d ? `  — ${d}` : ""}`); wait++; };

const gh = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  return res.ok ? res.json() : null;
};

console.log(`\n  Verifying ${TAG} — the version in package.json, not one typed here\n`);

console.log("  THE SOURCE REPO — what the workflow produced");
{
  const rel = await gh(`/repos/${SOURCE}/releases/tags/${TAG}`);
  if (!rel) no("a release exists for this tag", "the tag may not be pushed, or the build failed");
  else {
    ok("a release exists for this tag");
    // A draft is the workflow's default and the state the manual step starts
    // from. Left as a draft, the copy below cannot have happened.
    rel.draft ? no("and it is published", "still a DRAFT — publish it first") : ok("and it is published");
    ok(`with ${rel.assets?.length ?? 0} asset(s)`, (rel.assets ?? []).map((a) => a.name).join(", "));
  }
}

console.log("\n  THE PUBLIC REPO — what the hub actually reads");
let publicAssets = [];
{
  const rel = await gh(`/repos/${PUBLIC}/releases/tags/${TAG}`);
  if (!rel) {
    no("a release exists for this tag", "THE MANUAL COPY HAS NOT HAPPENED — this is the step with no error");
  } else {
    ok("a release exists for this tag");
    publicAssets = (rel.assets ?? []).map((a) => a.name);
    const dmg = publicAssets.find((n) => n.toLowerCase().endsWith(".dmg"));
    const exe = publicAssets.find((n) => n.toLowerCase().endsWith(".exe"));
    dmg ? ok("a macOS .dmg is attached", dmg) : no("a macOS .dmg is attached");
    exe ? ok("a Windows .exe is attached", exe) : no("a Windows .exe is attached");
    // The filename carries the version, so a stale asset uploaded under a new
    // tag is caught — the failure that looks most like success.
    const wrong = publicAssets.filter((n) => !n.includes(VERSION));
    wrong.length === 0
      ? ok("and every filename carries the version")
      : no("every filename carries the version", `these do not: ${wrong.join(", ")}`);
  }
}

console.log("\n  releases/latest — what the hub's fetch will return");
{
  const latest = await gh(`/repos/${PUBLIC}/releases/latest`);
  if (!latest) no("the API answers");
  else if (latest.tag_name === TAG) ok("points at this release", latest.tag_name);
  else no("points at this release", `it points at ${latest.tag_name} — an older release is still marked Latest`);
}

console.log("\n  THE HUB PAGE — what a visitor sees");
{
  const res = await fetch(PAGE, { headers: { "cache-control": "no-cache" } });
  const html = res.ok ? await res.text() : "";
  if (!res.ok) no("the page loads", `HTTP ${res.status}`);
  else if (html.includes(VERSION)) ok("shows this version");
  else soon(
    "shows this version",
    "not yet — the page is ISR with a 1h revalidate, so this turns over on its own. Re-run later; only worry if it is still stale after an hour.",
  );
}

console.log("\n  desktop-config — what installed copies are told");
{
  const res = await fetch(CONFIG, { headers: { "cache-control": "no-cache" } });
  const cfg = res.ok ? await res.json() : null;
  if (!cfg) no("the endpoint answers");
  else if (!cfg.latest_version) soon("latest_version is set", "still {} — deploy desktop-config once this release is live");
  else if (cfg.latest_version === VERSION) ok("latest_version matches", VERSION);
  else no("latest_version matches", `it says ${cfg.latest_version}`);

  // Never raise the floor as part of shipping. It bricks older installs at next
  // launch and there is no undo for somebody already told to update.
  cfg?.minimum_version
    ? no("minimum_version is left alone", `it is set to ${cfg.minimum_version} — raising a floor is its own decision`)
    : ok("minimum_version is left alone");
}

console.log(`\n  ${pass} passed, ${fail} failed, ${wait} waiting\n`);
process.exit(fail === 0 ? 0 : 1);
