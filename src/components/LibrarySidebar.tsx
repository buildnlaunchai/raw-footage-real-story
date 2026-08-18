/**
 * The sidebar: where footage lives, and how much room it is taking.
 *
 * Collections are projects — the same thing under the name the shelf uses.
 * Clicking one opens it, because a collection you cannot work in is a label.
 */
import { formatBytes, tagHue, type StorageUsage } from "../lib/library";
import type { ProjectSummary } from "../lib/project";
import { DocIcon, FilmIcon, FolderIcon, HomeIcon, RefreshIcon } from "./Icons";

/**
 * Sidebar destinations.
 *
 * "project" is where the pipeline lives — it is reached by opening a
 * collection rather than by a nav row of its own, because it only means
 * anything with a collection open.
 */
export type LibraryView = "home" | "projects" | "all" | "project" | "settings" | "readiness";

interface Props {
  view: LibraryView;
  onView: (v: LibraryView) => void;
  counts: { all: number };
  projects: ProjectSummary[];
  openProjectId: string | null;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  /** False past the grace period — see `allowsNewProjects` in entitlement.ts. */
  canCreate: boolean;
  /** Re-read projects and storage from disk. */
  onRefresh: () => void;
  refreshing: boolean;
  storage: StorageUsage | null;
  /** Whose machine this is. There are no accounts; this is the OS user. */
  userName: string;
  onOpenSettings: () => void;
  /** How many things need attention, for the always-visible chip. */
  attention: number;
  /** False when a blocking dependency is missing. */
  usable: boolean;
  onOpenReadiness: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const NAV: { id: LibraryView; label: string; Icon: typeof HomeIcon }[] = [
  { id: "home", label: "Home", Icon: HomeIcon },
  { id: "projects", label: "Projects", Icon: FolderIcon },
  { id: "all", label: "All Videos", Icon: FilmIcon },
];

export function LibrarySidebar({
  view,
  onView,
  counts,
  projects,
  openProjectId,
  onOpenProject,
  onNewProject,
  canCreate,
  onRefresh,
  refreshing,
  storage,
  userName,
  onOpenSettings,
  attention,
  usable,
  onOpenReadiness,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const countFor = (id: LibraryView) => (id === "all" ? counts.all : null);

  // Only the app's own data is a share of anything meaningful; footage is
  // referenced where the user already keeps it.
  const total = storage?.diskTotalBytes ?? null;
  const used = storage ? storage.appBytes + storage.footageBytes : 0;

  return (
    <aside className="lib-side" data-collapsed={collapsed || undefined}>
      <div className="lib-brand-row">
        {!collapsed && <p className="lib-brand">Raw Footage</p>}
        <button
          type="button"
          className="lib-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? "Show the sidebar" : "Hide the sidebar"}
          aria-label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <ul className="lib-nav">
        {NAV.map(({ id, label, Icon }) => {
          const n = countFor(id);
          return (
            <li key={id}>
              <button
                type="button"
                className="lib-nav-item"
                aria-current={view === id}
                onClick={() => onView(id)}
                title={collapsed ? label : undefined}
              >
                <Icon size={19} />
                <span className="lib-label">{label}</span>
                {n !== null && n > 0 && <span className="lib-count">{n}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      <hr className="lib-sep" />

      <div className="lib-side-head">
        <span>Collections</span>
        <span className="lib-side-tools">
          <button
            type="button"
            className="lib-add"
            onClick={onRefresh}
            disabled={refreshing}
            title="Re-read projects from disk"
            aria-label="Refresh collections"
          >
            <span className={refreshing ? "is-spinning" : undefined}>
              <RefreshIcon size={13} />
            </span>
          </button>
          <button
            type="button"
            className="lib-add"
            onClick={onNewProject}
            disabled={!canCreate}
            title={canCreate ? "New project" : "Connect to the internet to start a new project"}
            aria-label="New project"
          >
            +
          </button>
        </span>
      </div>

      <ul className="lib-nav">
        {projects.length === 0 && (
          <li>
            <p className="hint" style={{ margin: "0 0 0 0.8rem" }}>
              None yet.
            </p>
          </li>
        )}
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="lib-nav-item"
              aria-current={openProjectId === p.id}
              onClick={() => onOpenProject(p.id)}
              title={`Open ${p.name}`}
            >
              <span style={{ color: `hsl(${tagHue(p.id)} 70% 62%)`, display: "flex" }}>
                <DocIcon size={17} />
              </span>
              {p.name}
              <span className="lib-count">{p.clipCount}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Always visible, so a dependency that breaks later is noticed without
          the user having to go looking for a setup screen. */}
      <button
        type="button"
        className="ready-chip"
        data-state={!usable ? "bad" : attention > 0 ? "warn" : "ok"}
        onClick={onOpenReadiness}
      >
        <span className="ready-chip-dot" />
        {!usable
          ? "ffmpeg missing"
          : attention > 0
            ? `${attention} need${attention === 1 ? "s" : ""} attention`
            : "Everything ready"}
      </button>

      <div
        className="lib-storage"
        title={
          "What this app is keeping on this Mac: the footage you imported into " +
          "collections, plus thumbnails, narration audio and rendered videos. " +
          "Your original video files are left where they are and are not counted twice."
        }
      >
        <p className="lib-storage-label">Used by this app</p>
        <p className="lib-storage-value">
          {storage ? formatBytes(used) : "—"}
          {total ? (
            <span className="lib-storage-free">
              {" · "}
              {formatBytes(total - used)} free on this Mac
            </span>
          ) : null}
        </p>

        {storage && (
          <>
            <div
              className="lib-storage-bar"
              role="img"
              aria-label={`${formatBytes(storage.footageBytes)} footage, ${formatBytes(
                storage.appBytes,
              )} app data`}
            >
              <span
                className="lib-storage-fill"
                style={{
                  width: total
                    ? `${Math.min(100, (storage.footageBytes / total) * 100)}%`
                    : `${(storage.footageBytes / Math.max(1, used)) * 100}%`,
                }}
              />
              <span
                className="lib-storage-fill is-app"
                style={{
                  width: total
                    ? `${Math.min(100, (storage.appBytes / total) * 100)}%`
                    : `${(storage.appBytes / Math.max(1, used)) * 100}%`,
                }}
              />
            </div>
            <p className="lib-storage-foot">
              <span>{formatBytes(storage.footageBytes)} footage</span>
              <span>{formatBytes(storage.appBytes)} audio &amp; renders</span>
            </p>
          </>
        )}
      </div>

      <button type="button" className="lib-user" onClick={onOpenSettings}>
        <span className="avatar">
          {userName.slice(0, 2).toUpperCase() || "··"}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="lib-user-name">{userName || "This machine"}</span>
          {/* No accounts and no roles: everything here is local to this Mac. */}
          <span className="lib-user-sub">Local · settings</span>
        </span>
      </button>
    </aside>
  );
}
