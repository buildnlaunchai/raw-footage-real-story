/** Voice selection, grouped by accent and gender — 55 flat options is unusable. */
import { groupVoices, type VoiceInfo } from "../lib/voiceover";

interface Props {
  voices: VoiceInfo[];
  selected: string;
  disabled: boolean;
  previewing: boolean;
  onSelect: (id: string) => void;
  onPreview: () => void;
}

export function VoicePicker({
  voices,
  selected,
  disabled,
  previewing,
  onSelect,
  onPreview,
}: Props) {
  const recommended = voices.filter((v) => v.recommended);
  const groups = groupVoices(voices);

  return (
    <div className="voice-picker">
      <label className="field-label" htmlFor="voice-select">
        Voice
      </label>
      <div className="voice-row">
        <select
          id="voice-select"
          className="select"
          value={selected}
          disabled={disabled || voices.length === 0}
          onChange={(e) => onSelect(e.currentTarget.value)}
        >
          {/* The shortlist first: 55 flat options is a survey, not a choice.
              Chosen by measurement — see voice_audition.rs. */}
          {recommended.length > 0 && (
            <optgroup label="Recommended for narration">
              {recommended.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.accent} {v.gender}
                </option>
              ))}
            </optgroup>
          )}
          {[...groups.entries()].map(([group, list]) => (
            <optgroup key={group} label={group}>
              {list.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <button
          type="button"
          className="ghost-button"
          onClick={onPreview}
          disabled={disabled || previewing || voices.length === 0}
        >
          {previewing ? "Preview…" : "▶ Preview"}
        </button>
      </div>
    </div>
  );
}
