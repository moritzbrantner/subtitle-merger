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
