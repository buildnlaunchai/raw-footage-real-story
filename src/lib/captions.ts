/**
 * Drawing captions as pictures, because nothing in ffmpeg can draw them.
 *
 * Both of ffmpeg's text tools were tried and both get Bengali wrong. libass,
 * behind the `subtitles` filter, does no complex shaping at all — Arabic does
 * not join and Devanagari does not reorder either. `drawtext` shapes some of it
 * and still puts ি and ে after their consonant: ক্রেডিট comes out ক্রডেটি. Every
 * font produced the same result, so it is the tools, not the fonts.
 *
 * The webview draws it correctly. That is not a hope — it was the reference
 * used to catch the other two, compared glyph for glyph against the same string
 * rendered by a browser. So the app draws each caption itself and hands ffmpeg
 * a picture to place, which is a thing every build of ffmpeg can do without any
 * font, shaper or library involved.
 *
 * One consequence worth keeping in mind: what the viewer shows and what the
 * video gets are now produced by the same renderer, so a caption cannot look
 * right in the preview and wrong in the export.
 */

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionImage extends CaptionCue {
  /** PNG bytes, base64, transparent outside the text. */
  png: string;
  width: number;
  height: number;
}

export interface CaptionStyle {
  /** Text height as a fraction of the frame height. */
  size: number;
  colour: string;
  boxBehind: boolean;
}

/** Loaded once so every caption is measured against the same metrics. */
let fontReady: Promise<void> | null = null;

/**
 * The bundled faces, in the order they should be tried.
 *
 * All registered under one family name on purpose. A browser falls back within
 * a family per *glyph*, so a Bengali sentence with an English place name in it
 * gets Bengali from the Bengali face and Latin from the Latin one, without
 * anybody having to detect a language first. Latin last so it never wins a
 * character one of the others should have drawn.
 */
export const CAPTION_FACES = [
  "NotoSansBengali-Regular.ttf",
  "NotoSansDevanagari-Regular.ttf",
  "NotoSansArabic-Regular.ttf",
  "NotoSansThai-Regular.ttf",
  "NotoSans-Regular.ttf",
];

/**
 * Make the bundled fonts available to the canvas.
 *
 * Bundled rather than borrowed from the machine for the same reason the fonts
 * were bundled before: a Mac with no Bengali font installed would otherwise
 * draw boxes, and we would have moved the problem rather than solved it.
 */
export function loadCaptionFont(family: string, urls: string[]): Promise<void> {
  if (!fontReady) {
    fontReady = (async () => {
      let loaded = 0;
      for (const url of urls) {
        try {
          const face = new FontFace(family, `url("${url}")`);
          await face.load();
          document.fonts.add(face);
          loaded++;
        } catch (err) {
          // One missing face is not worth failing the rest for; the remaining
          // ones and the system stack still cover most text.
          console.warn(`caption font failed to load: ${url}`, err);
        }
      }
      // Said out loud rather than swallowed. This has already gone wrong once:
      // the asset protocol's scope did not include the app's own resources, so
      // every face was refused and captions silently fell back to the system
      // stack — correct on a Mac, boxes on a machine with no Bengali font, and
      // invisible either way.
      if (loaded === 0 && urls.length > 0) {
        console.warn(
          "no bundled caption font loaded — captions will use whatever fonts " +
            "this machine has, which may not cover the script",
        );
      }
    })();
  }
  return fontReady;
}

/** How far in from each edge a caption must stay. */
const SIDE_MARGIN = 0.04;

/**
 * A size that keeps the line inside the frame.
 *
 * Captions are one line by design, and how wide a line runs depends on the
 * script as much as on the character count — the wrap is counted in
 * characters, and a Bengali character is nearly twice a Latin one, so a line
 * that fits in English can overrun in Bengali at the same setting. Shrinking
 * costs a little legibility on the occasional long line. Not shrinking takes
 * the ends off a sentence, which costs the sentence.
 *
 * Separate from the drawing so the rule can be tested without a canvas.
 */
export function shrinkToFit(fontPx: number, widthPx: number, frameWidth: number): number {
  const maxW = frameWidth * (1 - SIDE_MARGIN * 2);
  if (widthPx <= maxW || widthPx <= 0) return fontPx;
  return Math.max(12, Math.floor((fontPx * maxW) / widthPx));
}

/**
 * Draw one caption onto a canvas and return it as a PNG.
 *
 * Sized to the text rather than the frame: a full-frame image per caption
 * would be eight megabytes decoded, and a film has hundreds of them.
 *
 * `box` makes every caption come out the same size, drawn centred and sitting
 * on the box's floor. That is what lets the whole set become a single video
 * track instead of one input per caption — see `drawCaptions`.
 */
export function drawCaption(
  text: string,
  style: CaptionStyle,
  frameHeight: number,
  frameWidth: number,
  family: string,
  box?: { width: number; height: number },
): { png: string; width: number; height: number } {
  // Measure first, on a throwaway context, so the real canvas is exactly the
  // size of what goes on it.
  const measure = document.createElement("canvas").getContext("2d")!;
  const fontAt = (px: number) => `600 ${px}px "${family}", system-ui, sans-serif`;

  let fontPx = Math.max(12, Math.round(frameHeight * style.size));
  measure.font = fontAt(fontPx);

  const fitted = shrinkToFit(
    fontPx,
    measure.measureText(text).width + Math.round(fontPx * 0.4) * 2,
    frameWidth,
  );
  if (fitted !== fontPx) {
    fontPx = fitted;
    measure.font = fontAt(fontPx);
  }

  const pad = Math.round(fontPx * 0.4);
  const font = fontAt(fontPx);
  const m = measure.measureText(text);
  // Actual ascent and descent rather than the em box: Bengali and Devanagari
  // hang marks well above and below it, and a canvas cropped to the em clips
  // them off.
  const ascent = m.actualBoundingBoxAscent || fontPx * 0.8;
  const descent = m.actualBoundingBoxDescent || fontPx * 0.35;
  const textW = Math.ceil(m.width);
  // Not clamped to the frame: the size was already chosen so it fits, and a
  // clamp here would quietly cut the ends off instead of failing the fit.
  const w = textW + pad * 2;
  const h = Math.ceil(ascent + descent) + pad * 2;

  // Every caption is drawn on a canvas of the same size when a box is given,
  // centred in it and resting on its floor. Bottom-aligned rather than
  // centred vertically because the box is placed by its floor: a tall line and
  // a short one must sit at the same height above the bottom of the frame,
  // and only their tops may differ.
  const canvasW = box?.width ?? w;
  const canvasH = box?.height ?? h;
  const offsetX = Math.round((canvasW - w) / 2);
  const offsetY = canvasH - h;

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const c = canvas.getContext("2d")!;
  c.font = font;
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  const x = offsetX + w / 2;
  const y = offsetY + pad + ascent;

  if (style.boxBehind) {
    c.fillStyle = "rgba(0,0,0,0.55)";
    const r = Math.round(fontPx * 0.18);
    roundRect(c, offsetX, offsetY, w, h, r);
    c.fill();
  }

  // Outline first, then the fill on top, so the text stays legible over a
  // bright sky or a white wall without a box behind it.
  c.lineJoin = "round";
  c.lineWidth = Math.max(2, fontPx * 0.11);
  c.strokeStyle = "rgba(0,0,0,0.85)";
  c.strokeText(text, x, y);
  c.fillStyle = style.colour;
  c.fillText(text, x, y);

  return {
    png: canvas.toDataURL("image/png").split(",")[1],
    width: canvasW,
    height: canvasH,
  };
}

/** A blank frame of the caption box, for the gaps where nobody is speaking. */
export function blankCaption(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  // Left untouched, so every pixel is transparent black.
  return canvas.toDataURL("image/png").split(",")[1];
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/**
 * Draw every caption for a cut, all the same size.
 *
 * They come out identical in size on purpose, so ffmpeg can play them as one
 * video track rather than opening one image per caption. That matters more
 * than it sounds: as separate inputs, a film with 293 captions handed ffmpeg
 * 293 files and 293 overlay filters, and *every frame of the film* was pushed
 * through all 293 of them to find the one that might be showing. Measured on a
 * 79-clip cut, that was 82% of the render — 1.2 seconds of work became 6.7 —
 * and it cost around 880 of the process's threads. One track is one input and
 * one overlay, whatever the length of the film.
 *
 * Two passes, because the common size cannot be known until every caption has
 * been measured, and a caption's size depends on its own text: a long line is
 * shrunk to fit the frame, so it is not merely wider but set smaller.
 */
export function drawCaptions(
  cues: CaptionCue[],
  style: CaptionStyle,
  frameWidth: number,
  frameHeight: number,
  family: string,
): { images: CaptionImage[]; box: { width: number; height: number } } {
  if (cues.length === 0) return { images: [], box: { width: 0, height: 0 } };

  // First pass: what size does each one want to be?
  const sizes = cues.map((cue) => drawCaption(cue.text, style, frameHeight, frameWidth, family));
  const box = {
    width: Math.max(1, ...sizes.map((s) => s.width)),
    height: Math.max(1, ...sizes.map((s) => s.height)),
  };

  // Second pass: the same caption again, this time on a canvas of the common
  // size. Redrawn rather than composited, so there is one drawing path and no
  // chance of the two disagreeing about where the text sits.
  const images = cues.map((cue) => ({
    ...cue,
    ...drawCaption(cue.text, style, frameHeight, frameWidth, family, box),
  }));
  return { images, box };
}
