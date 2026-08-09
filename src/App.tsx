import "./App.css";

/**
 * v1 pipeline. Each stage runs locally on the user's machine:
 * clips -> descriptions -> LLM script (Ollama) -> TTS voiceover -> ffmpeg rough cut.
 * Nothing here is wired up yet; this is the scaffold shell.
 */
const STAGES = [
  {
    step: "01",
    title: "Add clips",
    body: "Drop in raw footage and tag each clip with a one-line description of what's in it.",
  },
  {
    step: "02",
    title: "Generate script",
    body: "A local LLM turns those descriptions into a narration script. Offline, no API cost.",
  },
  {
    step: "03",
    title: "Generate voiceover",
    body: "A local TTS engine reads the script back as an audio track.",
  },
  {
    step: "04",
    title: "Assemble rough cut",
    body: "Sentences are matched to the clips that fit them, ordered, and laid under the voiceover.",
  },
];

function App() {
  return (
    <main className="app">
      <header className="masthead">
        <p className="eyebrow">Build &amp; Launch AI</p>
        <h1>Raw Footage, Real Story</h1>
        <p className="lede">
          You shot the trip. This turns the pile of clips into a narrated rough
          cut — entirely on your own machine.
        </p>
      </header>

      <ol className="stages">
        {STAGES.map((stage) => (
          <li key={stage.step} className="stage">
            <span className="stage-step">{stage.step}</span>
            <div>
              <h2>{stage.title}</h2>
              <p>{stage.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <footer className="footer">
        <span className="badge">Scaffold</span>
        <p>
          Project scaffolded. No pipeline stage is implemented yet — see the
          README for local dependency setup.
        </p>
      </footer>
    </main>
  );
}

export default App;
