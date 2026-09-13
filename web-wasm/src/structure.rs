use super::document::{parse_document, serialize_document, DocumentCue, DocumentFormat, SubtitleDocument};
use super::source_rewrite::{serialize_merged_document, serialize_split_document};
use super::{clean_ass_text, push_json_string, return_json};

const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;

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
            .ok_or_else(|| "Structural cue edit input ended unexpectedly.".to_string())?;
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

    fn source(&mut self) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        if len > MAX_SOURCE_BYTES {
            return Err("Subtitle source exceeds the supported structural edit size.".into());
        }
        self.take(len)
    }

    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn parse_split_request(bytes: &[u8]) -> Result<(&[u8], usize, u64, u32), String> {
    let mut reader = Reader::new(bytes);
    let source = reader.source()?;
    let cue_index = reader.u32()? as usize;
    let split_ms = reader.u64()?;
    let text_offset_utf16 = reader.u32()?;
    if !reader.finished() {
        return Err("Split cue input contains trailing bytes.".into());
    }
    Ok((source, cue_index, split_ms, text_offset_utf16))
}

fn parse_merge_request(bytes: &[u8]) -> Result<(&[u8], usize), String> {
    let mut reader = Reader::new(bytes);
    let source = reader.source()?;
    let cue_index = reader.u32()? as usize;
    if !reader.finished() {
        return Err("Merge cue input contains trailing bytes.".into());
    }
    Ok((source, cue_index))
}

fn fail_on_parse_warnings(document: &SubtitleDocument) -> Result<(), String> {
    if document.warnings.is_empty() {
        return Ok(());
    }
    Err(format!(
        "This subtitle document cannot be structurally edited losslessly because parsing reported: {}",
        document.warnings.join(" ")
    ))
}

fn plain_text(format: &DocumentFormat, raw_text: &str) -> String {
    match format {
        DocumentFormat::Ass | DocumentFormat::Ssa => clean_ass_text(raw_text.trim()),
        DocumentFormat::Srt | DocumentFormat::WebVtt => raw_text.to_string(),
    }
}

fn utf16_offset_to_byte(text: &str, target: u32) -> Option<usize> {
    let target = target as usize;
    let mut utf16_offset = 0;
    for (byte_offset, character) in text.char_indices() {
        if utf16_offset == target {
            return Some(byte_offset);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > target {
            return None;
        }
    }
    (utf16_offset == target).then_some(text.len())
}

fn normalize_srt_sequence_identifiers(document: &mut SubtitleDocument) {
    if document.format != DocumentFormat::Srt {
        return;
    }
    for cue in &mut document.cues {
        if cue
            .identifier
            .as_deref()
            .is_some_and(|identifier| identifier.trim().parse::<u64>().is_ok())
        {
            cue.identifier = None;
        }
    }
}

fn apply_split(
    source: &[u8],
    cue_index: usize,
    split_ms: u64,
    text_offset_utf16: u32,
) -> Result<String, String> {
    let mut document = parse_document(source);
    fail_on_parse_warnings(&document)?;
    let format = document.format.clone();
    let cue_count = document.cues.len();
    let original = document.cues.get(cue_index).cloned().ok_or_else(|| {
        format!(
            "Cue index {cue_index} is outside the document's {cue_count} cues."
        )
    })?;
    if split_ms <= original.start_ms || split_ms >= original.end_ms {
        return Err("Split time must be strictly inside the cue timing range.".into());
    }
    let split_byte = utf16_offset_to_byte(&original.raw_text, text_offset_utf16)
        .ok_or_else(|| "Split text offset does not land on a UTF-16 character boundary.".to_string())?;
    let left_raw = original.raw_text[..split_byte].to_string();
    let right_raw = original.raw_text[split_byte..].to_string();
    if left_raw.trim().is_empty() || right_raw.trim().is_empty() {
        return Err("Split text must leave non-empty text on both sides of the cursor.".into());
    }

    let mut first = original.clone();
    first.end_ms = split_ms;
    first.raw_text = left_raw.clone();
    first.text = plain_text(&format, &left_raw);

    let mut second = original;
    second.start_ms = split_ms;
    second.raw_text = right_raw.clone();
    second.text = plain_text(&format, &right_raw);
    if matches!(format, DocumentFormat::Srt | DocumentFormat::WebVtt) {
        second.identifier = None;
    }

    document.cues[cue_index] = first;
    document.cues.insert(cue_index + 1, second);
    normalize_srt_sequence_identifiers(&mut document);

    let content = if format == DocumentFormat::Srt {
        serialize_document(&document)
    } else {
        serialize_split_document(source, &document, cue_index)?
    };
    let reparsed = parse_document(content.as_bytes());
    let first = reparsed.cues.get(cue_index);
    let second = reparsed.cues.get(cue_index + 1);
    let split_roundtrips = reparsed.warnings.is_empty()
        && reparsed.format == format
        && reparsed.cues.len() == cue_count + 1
        && first.is_some_and(|cue| {
            cue.start_ms == document.cues[cue_index].start_ms
                && cue.end_ms == split_ms
                && cue.raw_text == left_raw
        })
        && second.is_some_and(|cue| {
            cue.start_ms == split_ms
                && cue.end_ms == document.cues[cue_index + 1].end_ms
                && cue.raw_text == right_raw
        });
    if !split_roundtrips {
        return Err(
            "This cue split cannot be represented losslessly in the source subtitle format. Choose a different text cursor or split time."
                .into(),
        );
    }

    Ok(content)
}

fn field_index(fields: &[String], name: &str, fallback: usize) -> usize {
    fields
        .iter()
        .position(|field| field.trim().eq_ignore_ascii_case(name))
        .unwrap_or(fallback)
}

fn ass_metadata_matches(document: &SubtitleDocument, left: &DocumentCue, right: &DocumentCue) -> bool {
    let mut left_values = left.ass_values.clone();
    let mut right_values = right.ass_values.clone();
    let width = left_values.len().max(right_values.len()).max(document.ass_event_format.len());
    left_values.resize(width, String::new());
    right_values.resize(width, String::new());
    let start_index = field_index(&document.ass_event_format, "Start", 1);
    let end_index = field_index(&document.ass_event_format, "End", 2);
    let text_index = field_index(
        &document.ass_event_format,
        "Text",
        document.ass_event_format.len().saturating_sub(1),
    );
    for index in [start_index, end_index, text_index] {
        if index < width {
            left_values[index].clear();
            right_values[index].clear();
        }
    }
    left_values == right_values
}

fn merge_metadata_is_compatible(
    document: &SubtitleDocument,
    left: &DocumentCue,
    right: &DocumentCue,
) -> bool {
    match document.format {
        DocumentFormat::Srt => {
            left.settings == right.settings
                && right
                    .identifier
                    .as_deref()
                    .is_none_or(|identifier| identifier.trim().parse::<u64>().is_ok())
        }
        DocumentFormat::WebVtt => left.settings == right.settings && right.identifier.is_none(),
        DocumentFormat::Ass | DocumentFormat::Ssa => ass_metadata_matches(document, left, right),
    }
}

fn apply_merge(source: &[u8], cue_index: usize) -> Result<String, String> {
    let mut document = parse_document(source);
    fail_on_parse_warnings(&document)?;
    let format = document.format.clone();
    let cue_count = document.cues.len();
    let left = document.cues.get(cue_index).cloned().ok_or_else(|| {
        format!(
            "Cue index {cue_index} is outside the document's {cue_count} cues."
        )
    })?;
    let right = document.cues.get(cue_index + 1).cloned().ok_or_else(|| {
        "Merge requires a following cue in source order.".to_string()
    })?;
    if !merge_metadata_is_compatible(&document, &left, &right) {
        return Err(
            "The adjacent cues carry different source metadata, so merging them would discard supported subtitle semantics."
                .into(),
        );
    }

    let separator = match format {
        DocumentFormat::Ass | DocumentFormat::Ssa => "\\N",
        DocumentFormat::Srt | DocumentFormat::WebVtt => "\n",
    };
    let merged_raw = format!("{}{}{}", left.raw_text, separator, right.raw_text);
    let mut merged = left;
    merged.start_ms = merged.start_ms.min(right.start_ms);
    merged.end_ms = merged.end_ms.max(right.end_ms);
    merged.raw_text = merged_raw.clone();
    merged.text = plain_text(&format, &merged_raw);

    document.cues[cue_index] = merged;
    document.cues.remove(cue_index + 1);
    normalize_srt_sequence_identifiers(&mut document);

    let content = if format == DocumentFormat::Srt {
        serialize_document(&document)
    } else {
        serialize_merged_document(source, &document, cue_index)?
    };
    let reparsed = parse_document(content.as_bytes());
    let merged = reparsed.cues.get(cue_index);
    let merge_roundtrips = reparsed.warnings.is_empty()
        && reparsed.format == format
        && reparsed.cues.len() + 1 == cue_count
        && merged.is_some_and(|cue| {
            cue.start_ms == document.cues[cue_index].start_ms
                && cue.end_ms == document.cues[cue_index].end_ms
                && cue.raw_text == merged_raw
        });
    if !merge_roundtrips {
        return Err(
            "This cue merge cannot be represented losslessly in the source subtitle format."
                .into(),
        );
    }

    Ok(content)
}

fn success_json(content: &str) -> String {
    let mut output = String::from("{\"content\":");
    push_json_string(&mut output, content);
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
pub unsafe extern "C" fn split_subtitle_cue(ptr: u32, len: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    let result = parse_split_request(bytes)
        .and_then(|(source, cue_index, split_ms, text_offset_utf16)| {
            apply_split(source, cue_index, split_ms, text_offset_utf16)
        });
    return_json(match result {
        Ok(content) => success_json(&content),
        Err(message) => error_json(&message),
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn merge_subtitle_cues(ptr: u32, len: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    let result = parse_merge_request(bytes)
        .and_then(|(source, cue_index)| apply_merge(source, cue_index));
    return_json(match result {
        Ok(content) => success_json(&content),
        Err(message) => error_json(&message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_srt_deterministically_and_renumbers_sequence_identifiers() {
        let source = b"1\n00:00:01,000 --> 00:00:03,000\nHelloWorld\n\n2\n00:00:04,000 --> 00:00:05,000\nLater\n\n";
        let output = apply_split(source, 0, 2_000, 5).unwrap();
        let parsed = parse_document(output.as_bytes());

        assert_eq!(parsed.cues.len(), 3);
        assert_eq!(parsed.cues[0].raw_text, "Hello");
        assert_eq!(parsed.cues[0].end_ms, 2_000);
        assert_eq!(parsed.cues[1].raw_text, "World");
        assert_eq!(parsed.cues[1].start_ms, 2_000);
        assert!(output.contains("1\n00:00:01,000"));
        assert!(output.contains("2\n00:00:02,000"));
        assert!(output.contains("3\n00:00:04,000"));
    }

    #[test]
    fn split_rejects_invalid_time_or_utf16_boundary() {
        let source = b"1\n00:00:01,000 --> 00:00:03,000\nHello\n\n";
        assert!(apply_split(source, 0, 1_000, 2).is_err());
        let emoji_source = "1\n00:00:01,000 --> 00:00:03,000\nA😀B\n\n";
        assert!(apply_split(emoji_source.as_bytes(), 0, 2_000, 2).is_err());
    }

    #[test]
    fn merges_srt_and_renumbers_remaining_sequence_identifiers() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n\n3\n00:00:05,000 --> 00:00:06,000\nThree\n\n";
        let output = apply_merge(source, 0).unwrap();
        let parsed = parse_document(output.as_bytes());

        assert_eq!(parsed.cues.len(), 2);
        assert_eq!(parsed.cues[0].start_ms, 1_000);
        assert_eq!(parsed.cues[0].end_ms, 4_000);
        assert_eq!(parsed.cues[0].raw_text, "One\nTwo");
        assert!(output.contains("2\n00:00:05,000"));
        assert!(!output.contains("3\n00:00:05,000"));
    }

    #[test]
    fn merge_refuses_webvtt_metadata_loss() {
        let source = b"WEBVTT\n\ncue-a\n00:00:01.000 --> 00:00:02.000 line:80%\nOne\n\ncue-b\n00:00:03.000 --> 00:00:04.000 line:80%\nTwo\n\n";
        let error = apply_merge(source, 0).unwrap_err();

        assert!(error.contains("different source metadata"));
    }

    #[test]
    fn merge_preserves_ass_event_metadata_and_interleaved_comments() {
        let source = b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\nComment:0,0:00:02.00,0:00:02.50,Default,,0,0,0,,Keep between\nDialogue:0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Two\n";
        let output = apply_merge(source, 0).unwrap();
        let parsed = parse_document(output.as_bytes());

        assert_eq!(parsed.cues.len(), 1);
        assert_eq!(parsed.cues[0].raw_text, "One\\NTwo");
        assert!(output.contains("Comment:0,0:00:02.00"));
        assert!(output.contains("Keep between"));
    }
}
