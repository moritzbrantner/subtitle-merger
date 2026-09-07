import { SubtitleWorkbench } from "../components/SubtitleWorkbench";

export default function Home() {
  return (
    <main className="page-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">Subtitle Merger · browser lab</p>
          <h1>Inspect and merge subtitle tracks without uploading your media.</h1>
          <p className="lede">
            Select one reference video and as many SRT, WebVTT, ASS, or SSA files as you need. Rust compiled to WebAssembly inspects the container and extracts embedded text subtitle tracks locally.
          </p>
        </div>
        <a className="repo-link" href="https://github.com/moritzbrantner/subtitle-merger">
          Source on GitHub
        </a>
      </header>

      <SubtitleWorkbench />

      <footer className="site-footer">
        <p>
          Static Next.js + Rust/WASM. Video and subtitle bytes stay in this browser tab; no application server receives them.
        </p>
      </footer>
    </main>
  );
}
