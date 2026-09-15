# ADR 0005: Reference-video waveform ownership

Subtitle Merger may fetch the selected reference-video bytes and adapt them to a browser `File`, but it does not decode audio or calculate waveform samples.

`@moritzbrantner/timeline-editor/audio` owns browser audio decoding, PCM-to-waveform reduction, normalization, and audio-item rendering. Subtitle Merger consumes that contract and places the resulting waveform in a locked reference-audio lane whose duration remains authoritative from the reference video.

Waveform generation is presentation-only and non-blocking for video/subtitle loading. A failed waveform analysis must not replace or invalidate the accepted video/subtitle session, and an analysis result from a superseded load attempt must never commit.

The current browser path reads the complete media resource before analysis. If that becomes a material memory or startup cost, streaming/demux/WebCodecs support belongs in the reusable Timeline Editor audio boundary rather than in Subtitle Merger.
