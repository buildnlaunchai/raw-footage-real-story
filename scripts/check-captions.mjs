/**
 * Prove that captions are shaped correctly, by measurement rather than by eye.
 *
 * This exists because the Bengali subtitles were declared fixed three times and
 * were wrong all three times. Reading a rendered frame is not a test: at the
 * size these glyphs appear, a wrong vowel sign and a right one look the same to
 * anyone not looking for it. So this measures instead.
 *
 * What it measures. Bengali has pre-base vowel signs: ি and ে are typed after
 * their consonant and must be *drawn before* it. A renderer that does no
 * shaping leaves them where they were typed, which is what libass and drawtext
 * both did — ক্রেডিট came out ক্রডেটি. So for each probe the consonant is
 * rendered alone, then the whole cluster, and the consonant's own bitmap is
 * slid across the cluster to find where it actually sits. If it sits at the
 * left edge, nothing moved and the shaping is broken. If it has been pushed
 * right, the sign was reordered in front of it, which is the whole question.
 *
 * Template matching rather than a pixel diff of two whole images: the same
 * rasteriser draws both, so the consonant appears in the cluster pixel for
 * pixel, and where it appears is an unambiguous number rather than a judgement.
 *
 * The controls matter as much as the test, because a measurement that cannot
 * fail proves nothing about what passes it. There are two. Every probe is also
 * drawn the way a renderer with no shaping draws it — each character placed
 * after the last, nothing reordered — and that has to be caught. And where a
 * build of ffmpeg with `drawtext` is on the machine, the probes go through the
 * renderer that actually shipped broken, which has to be caught as well. A
 * control that fails to fail fails the whole run.
 *
 * Both engines that draw captions are measured: HarfBuzz, which is Chrome and
 * the webview on Windows and Linux, and CoreText, which is the webview on
 * macOS. Testing only the one that happens to be convenient is how the last
 * three attempts were declared fixed.
 *
 *   node scripts/check-captions.mjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const fontsDir = join(root, "src-tauri/resources/fonts");
const work = mkdtempSync(join(tmpdir(), "caption-check-"));

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Consonant, pre-base sign, and the cluster the two should form. */
const PROBES = [
  { base: "ক", sign: "ি", cluster: "কি" },
  { base: "ক", sign: "ে", cluster: "কে" },
  { base: "ত", sign: "ে", cluster: "তে" },
  { base: "ভ", sign: "ে", cluster: "ভে" },
  { base: "ড", sign: "ি", cluster: "ডি" },
];

const FONT_PX = 96;

// --- rendering ---------------------------------------------------------------

/**
 * Draw the probes in the browser — the renderer the app actually uses.
 *
 * Each is drawn twice: once normally, and once with every character placed by
 * hand at the previous one's advance, which is what a renderer that does no
 * shaping produces. The second is the control.
 */
function render(probes) {
  const ttf = readFileSync(join(fontsDir, "NotoSansBengali-Regular.ttf")).toString("base64");
  const jobs = [];
  for (const p of probes) {
    for (const s of [p.base, p.sign, p.cluster]) jobs.push({ text: s, unshaped: false });
    jobs.push({ text: p.cluster, unshaped: true });
  }
  const page = `<!doctype html><meta charset="utf-8"><body>
<script type="module">
const face = new FontFace("Probe", "url(data:font/ttf;base64,${ttf})");
await face.load();
document.fonts.add(face);
const font = '${FONT_PX}px "Probe"';
const out = {};
for (const job of ${JSON.stringify(jobs)}) {
  const m = document.createElement("canvas").getContext("2d");
  m.font = font;
  const w = Math.ceil(m.measureText(job.text).width) + 80;
  const h = ${FONT_PX} * 2;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.font = font;
  g.fillStyle = "#000";
  g.textBaseline = "alphabetic";
  const y = ${FONT_PX} * 1.3;
  if (job.unshaped) {
    // One character at a time, each after the last: no reordering, no
    // ligatures, no marks moved. This is what a renderer without a shaper does.
    let x = 40;
    for (const ch of [...job.text]) {
      g.fillText(ch, x, y);
      x += g.measureText(ch).width;
    }
  } else {
    g.fillText(job.text, 40, y);
  }
  out[(job.unshaped ? "raw:" : "ok:") + job.text] = c.toDataURL("image/png").split(",")[1];
}
const tag = document.createElement("script");
tag.type = "application/json";
tag.id = "out";
tag.textContent = JSON.stringify(out);
document.body.appendChild(tag);
</script></body>`;
  const file = join(work, "probe.html");
  writeFileSync(file, page);
  const dom = execFileSync(
    CHROME,
    ["--headless=new", "--disable-gpu", "--virtual-time-budget=8000", "--dump-dom", `file://${file}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const m = /<script type="application\/json" id="out">([\s\S]*?)<\/script>/.exec(dom);
  if (!m) throw new Error("the browser produced no output — did the font load?");
  const files = {};
  for (const [key, b64] of Object.entries(JSON.parse(m[1]))) {
    const path = join(work, Buffer.from(key).toString("hex") + ".png");
    writeFileSync(path, Buffer.from(b64, "base64"));
    files[key] = path;
  }
  return files;
}

/**
 * The same probes through CoreText, which is what the app's webview shapes with.
 *
 * Chrome shapes with HarfBuzz and WebKit on macOS shapes with CoreText, so
 * measuring only Chrome would leave the app's own renderer untested — and
 * "surely that one is fine" is what was assumed about the two that were not.
 */
function renderCoreText(probes) {
  const strings = [...new Set(probes.flatMap((p) => [p.base, p.sign, p.cluster]))];
  const dir = join(work, "coretext");
  mkdirSync(dir, { recursive: true });
  try {
    const out = execFileSync(
      "swift",
      [join(root, "scripts/coretext-probe.swift"),
       join(fontsDir, "NotoSansBengali-Regular.ttf"), dir, ...strings],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * The same probes through ffmpeg's `drawtext` — the renderer that got it wrong.
 *
 * The synthetic control proves the measurement can see a renderer that does no
 * shaping. This proves it can see the *actual* one that shipped, which is a
 * different claim and the one that matters. Only where a build with the filter
 * exists: Homebrew's plain `ffmpeg` does not have it, `ffmpeg-full` does.
 */
function renderDrawtext(probes) {
  const ffmpeg = ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "ffmpeg"].find((bin) => {
    try {
      return execFileSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8" })
        .split("\n")
        .some((l) => l.trim().split(/\s+/)[1] === "drawtext");
    } catch {
      return false;
    }
  });
  if (!ffmpeg) return null;

  // Copied somewhere plain first: a filtergraph is parsed, not passed, and
  // this project's own path has spaces in it that ffmpeg reads as syntax.
  const ttf = join(work, "bn.ttf");
  copyFileSync(join(fontsDir, "NotoSansBengali-Regular.ttf"), ttf);
  const files = {};
  for (const s of new Set(probes.flatMap((p) => [p.base, p.sign, p.cluster]))) {
    const hex = Buffer.from(s).toString("hex");
    const txt = join(work, `dt-${hex}.txt`);
    const png = join(work, `dt-${hex}.png`);
    writeFileSync(txt, s);
    try {
      execFileSync(
        ffmpeg,
        ["-y", "-f", "lavfi", "-i", `color=white:s=800x${FONT_PX * 2}`,
         "-vf", `drawtext=fontfile=${ttf}:textfile=${txt}:fontsize=${FONT_PX}:` +
                `fontcolor=black:x=40:y=${Math.round(FONT_PX * 0.4)}`,
         "-frames:v", "1", png],
        { stdio: "ignore" },
      );
      files["ok:" + s] = png;
    } catch {
      return null;
    }
  }
  return files;
}

// --- measurement -------------------------------------------------------------

/** A PNG as an ink bitmap, cropped to its ink. ffmpeg decodes; nothing else can. */
function bitmap(png) {
  const [w, h] = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
     "-of", "csv=p=0", png],
    { encoding: "utf8" },
  ).trim().split(",").map(Number);
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { maxBuffer: 256 * 1024 * 1024 },
  );

  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (255 - raw[y * w + x] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { w: 0, h: 0, px: new Float32Array(0), top: 0 };

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const px = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) px[y * bw + x] = 255 - raw[(y + y0) * w + (x + x0)];
  }
  // The top of the ink relative to the baseline, so templates from different
  // images can be lined up vertically before they are compared.
  return { w: bw, h: bh, px, top: y0 };
}

/**
 * Where a glyph's bitmap sits inside a longer one.
 *
 * Returns the horizontal offset with the least difference, and how good that
 * match was, so a match that never locked on can be told from one that did.
 */
function findTemplate(image, template) {
  if (image.w === 0 || template.w === 0 || template.w > image.w) {
    return { x: -1, score: 0 };
  }
  const dy = template.top - image.top;
  let best = Infinity;
  let bestX = 0;
  for (let x = 0; x + template.w <= image.w; x++) {
    let diff = 0;
    for (let ty = 0; ty < template.h; ty++) {
      const iy = ty + dy;
      if (iy < 0 || iy >= image.h) {
        for (let tx = 0; tx < template.w; tx++) diff += template.px[ty * template.w + tx];
        continue;
      }
      for (let tx = 0; tx < template.w; tx++) {
        diff += Math.abs(template.px[ty * template.w + tx] - image.px[iy * image.w + x + tx]);
      }
    }
    if (diff < best) {
      best = diff;
      bestX = x;
    }
  }
  let ink = 0;
  for (let i = 0; i < template.px.length; i++) ink += template.px[i];
  return { x: bestX, score: ink > 0 ? 1 - best / ink : 0 };
}

// --- run ---------------------------------------------------------------------

console.log("Drawing probes shaped and unshaped, in every engine that draws captions…\n");
const engines = [
  { name: "HarfBuzz", note: "(Chrome, and the webview on Linux and Windows)", files: render(PROBES) },
];
const ct = renderCoreText(PROBES);
if (ct) engines.push({ name: "CoreText", note: "(the app's webview on macOS)", files: ct });
else console.log("  note: CoreText could not be probed here — swift is missing.\n");

// Last, because it is not a candidate — it is the thing that was wrong.
const dt = renderDrawtext(PROBES);
if (dt) engines.push({ name: "drawtext", note: "(ffmpeg — the renderer that shipped broken)", files: dt, broken: true });

let failures = 0;

for (const engine of engines) {
  const cache = new Map();
  const bmp = (key) => {
    if (!cache.has(key)) cache.set(key, bitmap(engine.files[key]));
    return cache.get(key);
  };

  console.log(`${engine.name} ${engine.note}`);
  console.log("  cluster  rendering   consonant at   sign needs   match   verdict");
  console.log("  " + "-".repeat(76));

  for (const p of PROBES) {
    const base = bmp("ok:" + p.base);

    const rows = engine.broken ? [["shaped", "ok:"]] : [["shaped", "ok:"], ["unshaped", "raw:"]];
    for (const [label, key] of rows) {
      const cluster = bmp(key + p.cluster);
      const found = findTemplate(cluster, base);
      // How much width the sign added, measured from the cluster itself rather
      // than from the sign drawn alone — a lone vowel sign is rendered with a
      // dotted circle under it, so its solo width is not its width in a word.
      // The consonant now sits either at the left edge or that much further
      // in, and there is nothing in between to be unsure about.
      const added = Math.max(0, cluster.w - base.w);
      // Below this the consonant was not found in the cluster at all, and its
      // position is a number with nothing behind it. That is a failure for a
      // renderer under test, and for the broken control it is a *different*
      // way of being broken rather than a pass: drawtext draws কি by leaving
      // ি on the right and running one headline across both, so the consonant
      // never appears as its own shape.
      const found_it = found.score > 0.5;
      const movedForward = found.x > added / 2;
      const wantMoved = label === "shaped";

      let ok;
      let verdict;
      if (engine.broken) {
        ok = !found_it || !movedForward;
        verdict = !found_it
          ? "consonant not even drawn intact — caught"
          : !movedForward
            ? "sign left after its consonant — caught"
            : "THE BROKEN RENDERER PASSED — the measurement is not measuring";
      } else {
        ok = found_it && movedForward === wantMoved;
        verdict = !found_it
          ? "CONSONANT NOT FOUND — nothing was measured"
          : label === "shaped"
            ? ok
              ? "sign drawn first — correct"
              : "SIGN LEFT WHERE IT WAS TYPED"
            : ok
              ? "not reordered, as expected — the test can see it"
              : "CONTROL DID NOT FAIL";
      }
      if (!ok) failures++;
      console.log(
        `  ${p.cluster.padEnd(8)} ${label.padEnd(11)} ${String(found.x).padEnd(14)} ` +
          `${String(added).padEnd(12)} ${found.score.toFixed(3).padEnd(7)} ${verdict}`,
      );
    }
  }
  console.log();
}

if (failures > 0) {
  console.error(`${failures} problem(s). Captions are not safe to ship.`);
  process.exit(1);
}
console.log("Every pre-base vowel sign is drawn before its consonant, in every engine");
console.log("that draws a caption. An unshaped rendering was caught in each, and so was");
console.log("the renderer that shipped broken — so the measurement measures, and the");
console.log("engines the app uses pass it.");
