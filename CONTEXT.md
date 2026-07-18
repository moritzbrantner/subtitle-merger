# Subtitle Merger

Subtitle Merger aligns video files with nearby subtitle files for timeline editing.

## Language

**Video Stem**:
The selected video filename without its extension. It is the prefix used to find subtitle siblings.
_Avoid_: basename when referring specifically to matching behavior

**Subtitle Sibling**:
A subtitle file in the same directory as the selected video whose filename stem matches the video stem rules.
_Avoid_: sidecar when the matching rule matters

**Infix Title**:
The cleaned suffix between the video stem and subtitle extension. It becomes the subtitle track and item label.
_Avoid_: language code, suffix, raw suffix

**Reference Video**:
The selected video used for preview and timeline duration but not represented as a timeline track, item, asset, or inspector target.
_Avoid_: video item, video track

**Subtitle Track**:
The editable timeline representation of one valid Subtitle Sibling and its complete cue sequence.
_Avoid_: video track, cue track

**Subtitle Generation Job**:
A session-scoped request that uploads one video and produces source and optional translated subtitle tracks.

**Source Subtitle Track**:
The editable, time-aligned transcript in the spoken language.

**Translated Subtitle Track**:
A separately editable, time-aligned rendering of a Source Subtitle Track in one target language.

**Translation Pair**:
The source and target language combination used to select a translation model.

**Pivot Translation**:
A translation that passes through English because no validated direct Translation Pair exists.

**Model Cache**:
Persistent application-managed storage for downloaded ASR, alignment, translation, and diarization models.

**Session Workspace**:
Temporary server storage for a browser session's uploaded video and generation artifacts.
