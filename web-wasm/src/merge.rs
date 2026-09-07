use super::{push_json_string, return_json};

const MAX_TRACKS: u32 = 64;
const MAX_CUES_PER_TRACK: u32 = 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct MergeCue {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MergeTrack {
    title: String,
    offset_ms: i64,
    cues: Vec<MergeCue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FlatCue {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(len)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| "Merge input ended unexpectedly.".to_string())?;
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four-byte slice"),
        ))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().expect("eight-byte slice"),
        ))
    }

    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(
            self.take(8)?.try_into().expect("eight-byte slice"),
        ))
    }

    fn string(&mut self) -> Result<String, String> {
        let len = self.u32()? as usize;
        String::from_utf8(self.take(len)?.to_vec())
            .map_err(|_| "Merge input contained invalid UTF-8 text.".to_string())
    }

    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn parse_merge_tracks(bytes: &[u8]) -> Result<Vec<MergeTrack>, String> {
    let mut reader = Reader::new(bytes);
    let track_count = reader.u32()?;
    if track_count == 0 {
        return Err("Select at least one subtitle track to merge.".into());
    }
    if track_count > MAX_TRACKS {
        return Err(format!("At most {MAX_TRACKS} subtitle tracks can be merged at once."));
    }

    let mut tracks = Vec::with_capacity(track_count as usize);
    for _ in 0..track_count {
        let offset_ms = reader.i64()?;
        let title = reader.string()?;
        let cue_count = reader.u32()?;
        if cue_count > MAX_CUES_PER_TRACK {
            return Err(format!(
                "A subtitle track exceeded the {MAX_CUES_PER_TRACK}-cue merge limit."
            ));
        }
        let mut cues = Vec::with_capacity(cue_count as usize);
        for _ in 0..cue_count {
            let start_ms = reader.u64()?;
            let end_ms = reader.u64()?.max(start_ms);
            let text = reader.string()?;
            cues.push(MergeCue {
                start_ms,
                end_ms,
                text,
            });
        }
        tracks.push(MergeTrack {
            title,
            offset_ms,
            cues,
        });
    }

    if !reader.finished() {
        return Err("Merge input contained trailing bytes.".into());
    }
    Ok(tracks)
}

fn shift_time(value: u64, offset_ms: i64) -> u64 {
    if offset_ms >= 0 {
        value.saturating_add(offset_ms as u64)
    } else {
        value.saturating_sub(offset_ms.unsigned_abs())
    }
}

fn shifted_cues(track: &MergeTrack) -> Vec<MergeCue> {
    track
        .cues
        .iter()
        .filter_map(|cue| {
            let start_ms = shift_time(cue.start_ms, track.offset_ms);
            let end_ms = shift_time(cue.end_ms, track.offset_ms).max(start_ms);
            (end_ms > start_ms && !cue.text.trim().is_empty()).then(|| MergeCue {
                start_ms,
                end_ms,
                text: cue.text.clone(),
            })
        })
        .collect()
}

fn flatten_tracks(tracks: &[MergeTrack]) -> Vec<FlatCue> {
    let shifted: Vec<Vec<MergeCue>> = tracks.iter().map(shifted_cues).collect();
    let mut boundaries = Vec::new();
    for cues in &shifted {
        for cue in cues {
            boundaries.push(cue.start_ms);
            boundaries.push(cue.end_ms);
        }
    }
    boundaries.sort_unstable();
    boundaries.dedup();

    let mut output: Vec<FlatCue> = Vec::new();
    for window in boundaries.windows(2) {
        let start_ms = window[0];
        let end_ms = window[1];
        if end_ms <= start_ms {
            continue;
        }
        let mut track_texts = Vec::new();
        for cues in &shifted {
            let active: Vec<&str> = cues
                .iter()
                .filter(|cue| cue.start_ms < end_ms && cue.end_ms > start_ms)
                .map(|cue| cue.text.trim())
                .filter(|text| !text.is_empty())
                .collect();
            if !active.is_empty() {
                track_texts.push(active.join("\n"));
            }
        }
        if track_texts.is_empty() {
            continue;
        }
        let text = track_texts.join("\n");
        if let Some(last) = output.last_mut() {
            if last.end_ms == start_ms && last.text == text {
                last.end_ms = end_ms;
                continue;
            }
        }
        output.push(FlatCue {
            start_ms,
            end_ms,
            text,
        });
    }
    output
}

fn format_srt_time(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn format_vtt_time(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{millis:03}")
}

fn format_ass_time(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let centis = (milliseconds % 1_000) / 10;
    format!("{hours}:{minutes:02}:{seconds:02}.{centis:02}")
}

fn serialize_srt(tracks: &[MergeTrack]) -> String {
    let mut output = String::new();
    for (index, cue) in flatten_tracks(tracks).iter().enumerate() {
        output.push_str(&(index + 1).to_string());
        output.push('\n');
        output.push_str(&format_srt_time(cue.start_ms));
        output.push_str(" --> ");
        output.push_str(&format_srt_time(cue.end_ms));
        output.push('\n');
        output.push_str(&cue.text);
        output.push_str("\n\n");
    }
    output
}

fn serialize_webvtt(tracks: &[MergeTrack]) -> String {
    let mut output = String::from("WEBVTT\n\n");
    for cue in flatten_tracks(tracks) {
        output.push_str(&format_vtt_time(cue.start_ms));
        output.push_str(" --> ");
        output.push_str(&format_vtt_time(cue.end_ms));
        output.push('\n');
        output.push_str(&cue.text);
        output.push_str("\n\n");
    }
    output
}

fn ass_style_name(index: usize, title: &str) -> String {
    let slug: String = title
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .take(24)
        .collect();
    if slug.is_empty() {
        format!("Track{}", index + 1)
    } else {
        format!("Track{}_{}", index + 1, slug)
    }
}

fn ass_text(text: &str) -> String {
    text.replace('\r', "").replace('\n', "\\N")
}

fn serialize_ass(tracks: &[MergeTrack]) -> String {
    let mut output = String::from(
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
    );
    let style_names: Vec<String> = tracks
        .iter()
        .enumerate()
        .map(|(index, track)| ass_style_name(index, &track.title))
        .collect();
    for (index, style) in style_names.iter().enumerate() {
        let margin_v = 40 + index.saturating_mul(72);
        output.push_str(&format!(
            "Style: {style},Arial,54,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,{margin_v},1\n"
        ));
    }
    output.push_str("\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    for (track_index, track) in tracks.iter().enumerate() {
        for cue in shifted_cues(track) {
            output.push_str("Dialogue: 0,");
            output.push_str(&format_ass_time(cue.start_ms));
            output.push(',');
            output.push_str(&format_ass_time(cue.end_ms));
            output.push(',');
            output.push_str(&style_names[track_index]);
            output.push_str(",,0,0,0,,");
            output.push_str(&ass_text(&cue.text));
            output.push('\n');
        }
    }
    output
}

fn result_json(content: &str, extension: &str, mime_type: &str) -> String {
    let mut output = String::from("{\"content\":");
    push_json_string(&mut output, content);
    output.push_str(",\"extension\":");
    push_json_string(&mut output, extension);
    output.push_str(",\"mimeType\":");
    push_json_string(&mut output, mime_type);
    output.push('}');
    output
}

fn error_json(message: &str) -> String {
    let mut output = String::from("{\"error\":");
    push_json_string(&mut output, message);
    output.push('}');
    output
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn merge_tracks(ptr: u32, len: u32, format: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    let tracks = match parse_merge_tracks(bytes) {
        Ok(tracks) => tracks,
        Err(message) => return return_json(error_json(&message)),
    };
    let result = match format {
        1 => result_json(&serialize_ass(&tracks), "ass", "text/x-ssa;charset=utf-8"),
        2 => result_json(&serialize_srt(&tracks), "srt", "application/x-subrip;charset=utf-8"),
        3 => result_json(&serialize_webvtt(&tracks), "vtt", "text/vtt;charset=utf-8"),
        _ => error_json("Unknown merge output format."),
    };
    return_json(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, offset_ms: i64, cues: &[(u64, u64, &str)]) -> MergeTrack {
        MergeTrack {
            title: title.into(),
            offset_ms,
            cues: cues
                .iter()
                .map(|(start_ms, end_ms, text)| MergeCue {
                    start_ms: *start_ms,
                    end_ms: *end_ms,
                    text: (*text).into(),
                })
                .collect(),
        }
    }

    fn encode(tracks: &[MergeTrack]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(tracks.len() as u32).to_le_bytes());
        for track in tracks {
            bytes.extend_from_slice(&track.offset_ms.to_le_bytes());
            bytes.extend_from_slice(&(track.title.len() as u32).to_le_bytes());
            bytes.extend_from_slice(track.title.as_bytes());
            bytes.extend_from_slice(&(track.cues.len() as u32).to_le_bytes());
            for cue in &track.cues {
                bytes.extend_from_slice(&cue.start_ms.to_le_bytes());
                bytes.extend_from_slice(&cue.end_ms.to_le_bytes());
                bytes.extend_from_slice(&(cue.text.len() as u32).to_le_bytes());
                bytes.extend_from_slice(cue.text.as_bytes());
            }
        }
        bytes
    }

    #[test]
    fn wire_format_roundtrips_track_order_offsets_and_cues() {
        let tracks = vec![
            track("Primary", -500, &[(1_000, 2_000, "One")]),
            track("Second", 250, &[(500, 1_500, "Two")]),
        ];
        assert_eq!(parse_merge_tracks(&encode(&tracks)).expect("wire format"), tracks);
    }

    #[test]
    fn negative_offset_clamps_at_zero_without_negative_time() {
        let shifted = shifted_cues(&track("A", -1_500, &[(1_000, 3_000, "Hello")]));
        assert_eq!(shifted[0].start_ms, 0);
        assert_eq!(shifted[0].end_ms, 1_500);
    }

    #[test]
    fn flattened_outputs_combine_overlaps_in_stable_track_order() {
        let tracks = vec![
            track("A", 0, &[(0, 2_000, "Alpha")]),
            track("B", 0, &[(1_000, 3_000, "Beta")]),
        ];
        assert_eq!(
            flatten_tracks(&tracks),
            vec![
                FlatCue { start_ms: 0, end_ms: 1_000, text: "Alpha".into() },
                FlatCue { start_ms: 1_000, end_ms: 2_000, text: "Alpha\nBeta".into() },
                FlatCue { start_ms: 2_000, end_ms: 3_000, text: "Beta".into() },
            ]
        );
        let srt = serialize_srt(&tracks);
        let vtt = serialize_webvtt(&tracks);
        assert!(srt.contains("Alpha\nBeta"));
        assert!(vtt.contains("Alpha\nBeta"));
    }

    #[test]
    fn ass_keeps_tracks_simultaneous_with_distinct_styles() {
        let tracks = vec![
            track("English", 0, &[(1_000, 3_000, "Hello")]),
            track("Deutsch", 250, &[(1_000, 3_000, "Hallo")]),
        ];
        let first = serialize_ass(&tracks);
        let second = serialize_ass(&tracks);
        assert_eq!(first, second);
        assert!(first.contains("Style: Track1_English"));
        assert!(first.contains("Style: Track2_Deutsch"));
        assert!(first.contains("Dialogue: 0,0:00:01.00,0:00:03.00,Track1_English"));
        assert!(first.contains("Dialogue: 0,0:00:01.25,0:00:03.25,Track2_Deutsch"));
    }
}
