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
export type LibraryView = "home" | "projects" | "all" | "project" | "settings";

interface Props {
  view: LibraryView;
  onView: (v: LibraryView) => void;
  counts: { all: number };
  projects: ProjectSummary[];
  openProjectId: string | null;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  /** Re-read projects and storage from disk. */
  onRefresh: () => void;
  refreshing: boolean;
  storage: StorageUsage | null;
  /** Whose machine this is. There are no accounts; this is the OS user. */
  userName: string;
  onOpenSettings: () => void;
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
  onRefresh,
  refreshing,
  storage,
  userName,
  onOpenSettings,
}: Props) {
  const countFor = (id: LibraryView) => (id === "all" ? counts.all : null);

  // Only the app's own data is a share of anything meaningful; footage is
  // referenced where the user already keeps it.
  const total = storage?.diskTotalBytes ?? null;
  const used = storage ? storage.appBytes + storage.footageBytes : 0;

  return (
    <aside className="lib-side">
      <p className="lib-brand">Raw Footage</p>

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
              >
                <Icon size={19} />
                {label}
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
            title="New project"
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

      <div className="lib-storage">
        <p className="lib-storage-label">Storage</p>
        <p className="lib-storage-value">
          {storage ? formatBytes(used) : "—"}
          {total ? ` of ${formatBytes(total)}` : ""}
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
              <span>{formatBytes(storage.appBytes)} app</span>
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
