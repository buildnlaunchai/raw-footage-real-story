/**
 * The frame: search and stage pills on top, rail on the left, dock at the foot.
 *
 * The pills and the dock are the same navigation as the rail, at two other
 * reaching distances — the rail for reading state, the pills for switching
 * while working, the dock for when the page is scrolled away from both.
 */
import { BellIcon, SaveIcon, SearchIcon, STAGE_ICONS } from "./Icons";
import { STAGES, STAGE_ORDER, type StageId, type StageStatus } from "../lib/pipeline";

interface Props {
  projectName: string;
  active: StageId;
  statuses: Record<StageId, StageStatus>;
  onStage: (id: StageId) => void;

  query: string;
  onQuery: (q: string) => void;

  dirty: boolean;
  saving: boolean;
  savedAt: string | null;
  onSave: () => void;

  /** Count of things asking for attention, shown on the bell. */
  attention: number;
  attentionLabel: string;

  onLeaveProject: () => void;

  rail: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell({
  projectName,
  active,
  statuses,
  onStage,
  query,
  onQuery,
  dirty,
  saving,
  savedAt,
  onSave,
  attention,
  attentionLabel,
  onLeaveProject,
  rail,
  children,
}: Props) {
  const initials = projectName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="shell">
      <div className="shell-inner">
        <header className="topbar">
          <label className="topbar-search">
            <SearchIcon />
            <span className="visually-hidden">Search clips and script lines</span>
            <input
              value={query}
              placeholder="Search clips and lines"
              onChange={(e) => onQuery(e.currentTarget.value)}
            />
          </label>

          <nav className="topbar-pills" aria-label="Stages">
            {STAGE_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className="pill"
                aria-current={active === id}
                onClick={() => onStage(id)}
              >
                {statuses[id] === "stale" && <span className="pill-dot" />}
                {STAGES[id].label}
              </button>
            ))}
          </nav>

          <div className="topbar-right">
            <button
              type="button"
              className="icon-button"
              onClick={onSave}
              disabled={saving || !dirty}
              title={
                dirty
                  ? "Save project (⌘S)"
                  : savedAt
                    ? `Saved at ${savedAt}`
                    : "Up to date"
              }
              data-alert={dirty || undefined}
            >
              <SaveIcon />
              <span className="visually-hidden">
                {dirty ? "Save project" : "Saved"}
              </span>
            </button>

            <button
              type="button"
              className="icon-button"
              data-alert={attention > 0 || undefined}
              title={attentionLabel}
            >
              <BellIcon />
              <span className="visually-hidden">{attentionLabel}</span>
            </button>

            <button
              type="button"
              className="project-chip"
              onClick={onLeaveProject}
              title="Back to projects"
            >
              <span className="avatar">{initials || "•"}</span>
              <span className="project-chip-name">{projectName}</span>
            </button>
          </div>
        </header>

        <div className="shell-body">
          {rail}
          <div className="main-col">{children}</div>
        </div>
      </div>

      <nav className="dock" aria-label="Jump to stage">
        {STAGE_ORDER.map((id) => {
          const Icon = STAGE_ICONS[id];
          return (
            <button
              key={id}
              type="button"
              className="dock-button"
              aria-current={active === id}
              data-status={statuses[id]}
              onClick={() => onStage(id)}
              title={`${STAGES[id].label} — ${statuses[id]}`}
            >
              <Icon />
              <span className="visually-hidden">{STAGES[id].label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
