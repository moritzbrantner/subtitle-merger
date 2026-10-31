export function SupportPanel() {
  return (
    <section className="support-panel" aria-labelledby="support-heading">
      <div>
        <p className="eyebrow">Embedded subtitle support</p>
        <h2 id="support-heading">Text tracks are extracted; bitmap tracks stay explicit.</h2>
      </div>
      <p>
        MP4/MOV extraction covers tx3g, WebVTT (wvtt), and TTML (stpp). Matroska/WebM covers UTF-8, WebVTT, ASS/SSA, and USF text tracks. PGS, VobSub, and other bitmap subtitle codecs are reported as unsupported rather than silently discarded.
      </p>
      <p>
        Video inspection runs in a Web Worker and streams only the byte ranges requested by Rust. MP4 metadata reads are capped at 64 MiB, coalesced subtitle-sample reads at 4 MiB, and Matroska subtitle blocks at 16 MiB. No server fallback is used.
      </p>
    </section>
  );
}
