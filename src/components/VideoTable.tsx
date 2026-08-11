/**
 * Every clip in the library, as a table you can describe from.
 *
 * Describing footage is the one task in this app that is genuinely bulk work,
 * and a table is the right shape for it: the description sits beside the frame
 * it belongs to, and moving down the list is one keystroke.
 */
import {
  containerOf,
  formatDuration,
  formatWhen,
  tagHue,
  type LibraryClip,
} from "../lib/library";
import { audioUrl } from "../lib/voiceover";
import { PencilIcon, PlayCircleIcon } from "./Icons";

interface Props {
  clips: LibraryClip[];
  onPlay: (clip: LibraryClip) => void;
  /** Open the describe view, which handles both whole clips and split ones. */
  onDescribe: (clip: LibraryClip) => void;
  onOpenProject: (projectId: string) => void;
}

export function VideoTable({
  clips,
  onPlay,
  onDescribe,
  onOpenProject,
}: Props) {
  const key = (c: LibraryClip) => `${c.projectId}/${c.clipId}`;

  return (
    <div className="lib-scroll">
      <table className="lib-table">
        <thead>
          <tr>
            <th>Video</th>
            <th>Description</th>
            <th>Duration</th>
            <th>Date added</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {clips.map((c) => {
            const k = key(c);
            const when = formatWhen(c.addedAt);
            const hue = tagHue(c.projectId);
            const spec = [
              containerOf(c.fileName),
              c.width && c.height ? `${c.width}x${c.height}` : null,
              c.codec,
              c.isHdr ? "HDR" : null,
            ]
              .filter(Boolean)
              .join(" • ");

            return (
              <tr key={k}>
                <td>
                  <div className="lib-video-cell">
                    <button
                      type="button"
                      className="lib-thumb"
                      onClick={() => onPlay(c)}
                      title="Play this clip"
                    >
                      {c.thumbnailPath ? (
                        <img src={audioUrl(c.thumbnailPath)} alt="" />
                      ) : (
                        <span className="lib-thumb-empty">no frame</span>
                      )}
                      <span className="lib-dur-badge">{formatDuration(c.durationMs)}</span>
                    </button>

                    <div style={{ minWidth: 0 }}>
                      <button
                        type="button"
                        className="lib-video-name lib-name-button"
                        title={c.fileName}
                        onClick={() => onDescribe(c)}
                      >
                        {c.fileName}
                      </button>
                      <p className="lib-video-spec">{spec}</p>
                      <button
                        type="button"
                        className="lib-tag"
                        style={{
                          color: `hsl(${hue} 70% 68%)`,
                          borderColor: `hsl(${hue} 60% 34%)`,
                          background: `hsl(${hue} 60% 16%)`,
                        }}
                        onClick={() => onOpenProject(c.projectId)}
                        title={`Open ${c.projectName}`}
                      >
                        {c.projectName}
                      </button>
                    </div>
                  </div>
                </td>

                <td>
                  {/* Editing happens in the describe view: it is the only one
                      that can express a clip split into several moments. */}
                  <button
                    type="button"
                    className="lib-desc lib-desc-open"
                    onClick={() => onDescribe(c)}
                    title="Describe this clip"
                  >
                    <span className={c.description ? undefined : "lib-desc-empty"}>
                      {c.description || "Not described yet"}
                    </span>
                    <span className="lib-desc-edit" aria-hidden="true">
                      <PencilIcon size={14} />
                    </span>
                  </button>

                  {c.segmentCount > 1 && (
                    <p className="lib-locked">{c.segmentCount} described moments</p>
                  )}
                </td>

                <td className="lib-when">{formatDuration(c.durationMs)}</td>

                <td className="lib-when">
                  {when.date}
                  <span>{when.time}</span>
                </td>

                <td>
                  <div className="lib-actions">
                    <button
                      type="button"
                      className="lib-act"
                      onClick={() => onPlay(c)}
                      title="Play"
                    >
                      <PlayCircleIcon />
                    </button>
                    <button
                      type="button"
                      className="lib-act"
                      onClick={() => onDescribe(c)}
                      title="Describe this clip"
                    >
                      <PencilIcon />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
