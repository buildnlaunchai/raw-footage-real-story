/**
 * The banner for whichever stage is open.
 *
 * Purely presentational — it takes what to say and what the buttons do. The
 * stage decides its own copy, because "what happens next" is different at every
 * step and a generic header would have to be vague to cover all five.
 */
import { ChevronDownIcon, ChevronUpIcon } from "./Icons";
import type { StageStatus } from "../lib/pipeline";

interface Props {
  badge: string;
  status: StageStatus;
  title: string;
  meta: (string | null)[];
  lede: string;
  /** Still frame or poster behind the copy, when the project has one. */
  media: string | null;
  actions: React.ReactNode;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

const STATUS_TONE: Record<StageStatus, string> = {
  empty: "○",
  ready: "●",
  working: "◐",
  done: "✓",
  stale: "!",
};

export function StageHero({
  badge,
  status,
  title,
  meta,
  lede,
  media,
  actions,
  onPrev,
  onNext,
}: Props) {
  const shown = meta.filter((m): m is string => Boolean(m));
  return (
    <section className="hero">
      {media && <img className="hero-media" src={media} alt="" />}

      <div className="hero-body">
        <span className="hero-badge">
          <span aria-hidden="true">{STATUS_TONE[status]}</span> {badge}
        </span>

        <h2 className="hero-title">{title}</h2>

        {shown.length > 0 && (
          <p className="hero-meta">
            {shown.map((m, i) => (
              <span key={m}>
                {i > 0 && <span className="sep">•&nbsp;</span>}
                {m}
              </span>
            ))}
          </p>
        )}

        <p className="hero-lede">{lede}</p>

        <div className="hero-actions">{actions}</div>
      </div>

      <div className="hero-nav">
        <button
          type="button"
          onClick={() => onPrev?.()}
          disabled={!onPrev}
          aria-label="Previous stage"
        >
          <ChevronUpIcon />
        </button>
        <button
          type="button"
          onClick={() => onNext?.()}
          disabled={!onNext}
          aria-label="Next stage"
        >
          <ChevronDownIcon />
        </button>
      </div>
    </section>
  );
}
