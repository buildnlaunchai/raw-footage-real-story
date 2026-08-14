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
      for (const url of urls) {
        try {
          const face = new FontFace(family, `url("${url}")`);
          await face.load();
          document.fonts.add(face);
        } catch {
          // One missing face is not worth failing the rest for; the remaining
          // ones and the system stack still cover most text.
        }
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
 */
export function drawCaption(
  text: string,
  style: CaptionStyle,
  frameHeight: number,
  frameWidth: number,
  family: string,
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

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d")!;
  c.font = font;
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  const x = w / 2;
  const y = pad + ascent;

  if (style.boxBehind) {
    c.fillStyle = "rgba(0,0,0,0.55)";
    const r = Math.round(fontPx * 0.18);
    roundRect(c, 0, 0, w, h, r);
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
    width: w,
    height: h,
  };
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

/** Draw every caption for a cut. */
export function drawCaptions(
  cues: CaptionCue[],
  style: CaptionStyle,
  frameWidth: number,
  frameHeight: number,
  family: string,
): CaptionImage[] {
  return cues.map((cue) => ({
    ...cue,
    ...drawCaption(cue.text, style, frameHeight, frameWidth, family),
  }));
}
