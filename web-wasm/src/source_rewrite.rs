use super::document::{serialize_document, DocumentFormat, SubtitleDocument};
use super::{decode_text, parse_timestamp};

pub(super) fn serialize_edited_document(
    source: &[u8],
    document: &SubtitleDocument,
    cue_index: usize,
) -> Result<String, String> {
    let source = normalize_newlines(&decode_text(source));
    let canonical = serialize_document(document);

    match document.format.clone() {
        DocumentFormat::Srt => replace_timed_block(&source, &canonical, cue_index, false),
        DocumentFormat::WebVtt => replace_timed_block(&source, &canonical, cue_index, true),
        DocumentFormat::Ass | DocumentFormat::Ssa => {
            replace_dialogue_line(&source, &canonical, cue_index)
        }
    }
}

pub(super) fn serialize_split_document(
    source: &[u8],
    document: &SubtitleDocument,
    cue_index: usize,
) -> Result<String, String> {
    let source = normalize_newlines(&decode_text(source));
    let canonical = serialize_document(document);

    match document.format.clone() {
        DocumentFormat::Srt => replace_timed_block_with_pair(&source, &canonical, cue_index, false),
        DocumentFormat::WebVtt => replace_timed_block_with_pair(&source, &canonical, cue_index, true),
        DocumentFormat::Ass | DocumentFormat::Ssa => {
            replace_dialogue_line_with_pair(&source, &canonical, cue_index)
        }
    }
}

pub(super) fn serialize_merged_document(
    source: &[u8],
    document: &SubtitleDocument,
    cue_index: usize,
) -> Result<String, String> {
    let source = normalize_newlines(&decode_text(source));
    let canonical = serialize_document(document);

    match document.format.clone() {
        DocumentFormat::Srt => merge_timed_blocks(&source, &canonical, cue_index, false),
        DocumentFormat::WebVtt => merge_timed_blocks(&source, &canonical, cue_index, true),
        DocumentFormat::Ass | DocumentFormat::Ssa => {
            merge_dialogue_lines(&source, &canonical, cue_index)
        }
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn replace_timed_block(
    source: &str,
    canonical: &str,
    cue_index: usize,
    webvtt: bool,
) -> Result<String, String> {
    let source_range = timed_block_range(source, cue_index, webvtt)
        .ok_or_else(|| "Could not locate the edited cue in the source document.".to_string())?;
    let canonical_range = timed_block_range(canonical, cue_index, webvtt)
        .ok_or_else(|| "Could not locate the edited cue in the serialized document.".to_string())?;

    Ok(replace_range(
        source,
        source_range,
        &canonical[canonical_range.0..canonical_range.1],
    ))
}

fn replace_timed_block_with_pair(
    source: &str,
    canonical: &str,
    cue_index: usize,
    webvtt: bool,
) -> Result<String, String> {
    let source_range = timed_block_range(source, cue_index, webvtt)
        .ok_or_else(|| "Could not locate the split cue in the source document.".to_string())?;
    let first = timed_block_range(canonical, cue_index, webvtt)
        .ok_or_else(|| "Could not locate the first split cue in the serialized document.".to_string())?;
    let second = timed_block_range(canonical, cue_index + 1, webvtt)
        .ok_or_else(|| "Could not locate the second split cue in the serialized document.".to_string())?;
    let replacement = format!(
        "{}\n\n{}",
        &canonical[first.0..first.1],
        &canonical[second.0..second.1]
    );

    Ok(replace_range(source, source_range, &replacement))
}

fn merge_timed_blocks(
    source: &str,
    canonical: &str,
    cue_index: usize,
    webvtt: bool,
) -> Result<String, String> {
    let first = timed_block_range(source, cue_index, webvtt)
        .ok_or_else(|| "Could not locate the first merged cue in the source document.".to_string())?;
    let second = timed_block_range(source, cue_index + 1, webvtt)
        .ok_or_else(|| "Could not locate the second merged cue in the source document.".to_string())?;
    let merged = timed_block_range(canonical, cue_index, webvtt)
        .ok_or_else(|| "Could not locate the merged cue in the serialized document.".to_string())?;
    let second_end = extend_through_separator(source, second.1, "\n\n");
    let between = &source[first.1..second.0];
    let replacement = format!("{}{}", &canonical[merged.0..merged.1], between);

    Ok(replace_range(source, (first.0, second_end), &replacement))
}

fn timed_block_range(text: &str, target_index: usize, webvtt: bool) -> Option<(usize, usize)> {
    let mut offset = 0;
    let mut cue_index = 0;

    for block in text.split("\n\n") {
        let start = offset;
        let end = start + block.len();
        let is_metadata = webvtt && is_webvtt_metadata_block(block);
        if !is_metadata && block.lines().any(is_timing_line) {
            if cue_index == target_index {
                return Some((start, end));
            }
            cue_index += 1;
        }
        offset = end.saturating_add(2);
    }

    None
}

fn is_webvtt_metadata_block(block: &str) -> bool {
    let block = block.trim_start();
    block.starts_with("NOTE") || block.starts_with("STYLE") || block.starts_with("REGION")
}

fn is_timing_line(line: &str) -> bool {
    let Some((start, rest)) = line.split_once("-->") else {
        return false;
    };
    let Some(end) = rest.split_whitespace().next() else {
        return false;
    };
    parse_timestamp(start.trim()).is_some() && parse_timestamp(end.trim()).is_some()
}

fn replace_dialogue_line(
    source: &str,
    canonical: &str,
    cue_index: usize,
) -> Result<String, String> {
    let source_range = dialogue_line_range(source, cue_index)
        .ok_or_else(|| "Could not locate the edited ASS/SSA cue in the source document.".to_string())?;
    let canonical_range = dialogue_line_range(canonical, cue_index)
        .ok_or_else(|| "Could not locate the edited ASS/SSA cue in the serialized document.".to_string())?;

    Ok(replace_range(
        source,
        source_range,
        &canonical[canonical_range.0..canonical_range.1],
    ))
}

fn replace_dialogue_line_with_pair(
    source: &str,
    canonical: &str,
    cue_index: usize,
) -> Result<String, String> {
    let source_range = dialogue_line_range(source, cue_index)
        .ok_or_else(|| "Could not locate the split ASS/SSA cue in the source document.".to_string())?;
    let first = dialogue_line_range(canonical, cue_index)
        .ok_or_else(|| "Could not locate the first split ASS/SSA cue in the serialized document.".to_string())?;
    let second = dialogue_line_range(canonical, cue_index + 1)
        .ok_or_else(|| "Could not locate the second split ASS/SSA cue in the serialized document.".to_string())?;
    let replacement = format!(
        "{}\n{}",
        &canonical[first.0..first.1],
        &canonical[second.0..second.1]
    );

    Ok(replace_range(source, source_range, &replacement))
}

fn merge_dialogue_lines(
    source: &str,
    canonical: &str,
    cue_index: usize,
) -> Result<String, String> {
    let first = dialogue_line_range(source, cue_index)
        .ok_or_else(|| "Could not locate the first merged ASS/SSA cue in the source document.".to_string())?;
    let second = dialogue_line_range(source, cue_index + 1)
        .ok_or_else(|| "Could not locate the second merged ASS/SSA cue in the source document.".to_string())?;
    let merged = dialogue_line_range(canonical, cue_index)
        .ok_or_else(|| "Could not locate the merged ASS/SSA cue in the serialized document.".to_string())?;
    let second_end = extend_through_separator(source, second.1, "\n");
    let between = &source[first.1..second.0];
    let replacement = format!("{}{}", &canonical[merged.0..merged.1], between);

    Ok(replace_range(source, (first.0, second_end), &replacement))
}

fn dialogue_line_range(text: &str, target_index: usize) -> Option<(usize, usize)> {
    let mut offset = 0;
    let mut cue_index = 0;

    for segment in text.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let start = offset;
        let end = start + line.len();
        if line.trim_start().starts_with("Dialogue:") {
            if cue_index == target_index {
                return Some((start, end));
            }
            cue_index += 1;
        }
        offset += segment.len();
    }

    None
}

fn extend_through_separator(source: &str, end: usize, separator: &str) -> usize {
    if source[end..].starts_with(separator) {
        end + separator.len()
    } else {
        end
    }
}

fn replace_range(source: &str, range: (usize, usize), replacement: &str) -> String {
    let mut output = String::with_capacity(source.len() - (range.1 - range.0) + replacement.len());
    output.push_str(&source[..range.0]);
    output.push_str(replacement);
    output.push_str(&source[range.1..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::parse_document;

    #[test]
    fn preserves_interleaved_webvtt_metadata_block_order() {
        let source = b"WEBVTT\n\ncue-a\n00:00:01.000 --> 00:00:02.000 line:80%\nOne\n\nNOTE between cues\nowner: test\n\ncue-b\n00:00:03.000 --> 00:00:04.000\nTwo\n\n";
        let mut document = parse_document(source);
        document.cues[0].start_ms = 1_250;
        document.cues[0].end_ms = 2_500;
        document.cues[0].raw_text = "Edited one".into();
        document.cues[0].text = "Edited one".into();

        let output = serialize_edited_document(source, &document, 0).unwrap();
        let first_cue = output.find("cue-a").unwrap();
        let note = output.find("NOTE between cues").unwrap();
        let second_cue = output.find("cue-b").unwrap();

        assert!(first_cue < note && note < second_cue);
        assert!(output.contains("00:00:01.250 --> 00:00:02.500 line:80%\nEdited one"));
        assert!(output.contains("owner: test"));
    }

    #[test]
    fn preserves_interleaved_ass_event_row_order() {
        let source = b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\nComment:0,0:00:02.00,0:00:02.50,Default,,0,0,0,,Keep between\nDialogue:0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Two\n";
        let mut document = parse_document(source);
        document.cues[1].start_ms = 3_250;
        document.cues[1].end_ms = 4_500;
        document.cues[1].raw_text = "Edited two".into();
        document.cues[1].text = "Edited two".into();

        let output = serialize_edited_document(source, &document, 1).unwrap();
        let first_cue = output.find("Dialogue:0,0:00:01.00").unwrap();
        let comment = output.find("Comment:0,0:00:02.00").unwrap();
        let second_cue = output.find("Dialogue:0,0:00:03.25").unwrap();

        assert!(first_cue < comment && comment < second_cue);
        assert!(output.contains("Dialogue:0,0:00:03.25,0:00:04.50,Default,,0,0,0,,Edited two"));
        assert!(output.contains("Keep between"));
    }

    #[test]
    fn split_keeps_webvtt_metadata_after_the_split_pair() {
        let source = b"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHelloWorld\n\nNOTE keep after split\n\n00:00:04.000 --> 00:00:05.000\nLater\n\n";
        let mut document = parse_document(source);
        let mut second = document.cues[0].clone();
        document.cues[0].end_ms = 2_000;
        document.cues[0].raw_text = "Hello".into();
        document.cues[0].text = "Hello".into();
        second.start_ms = 2_000;
        second.identifier = None;
        second.raw_text = "World".into();
        second.text = "World".into();
        document.cues.insert(1, second);

        let output = serialize_split_document(source, &document, 0).unwrap();
        let hello = output.find("Hello").unwrap();
        let world = output.find("World").unwrap();
        let note = output.find("NOTE keep after split").unwrap();
        let later = output.find("Later").unwrap();

        assert!(hello < world && world < note && note < later);
        assert_eq!(parse_document(output.as_bytes()).cues.len(), 3);
    }

    #[test]
    fn merge_keeps_ass_comment_between_merged_cue_and_following_rows() {
        let source = b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\nComment:0,0:00:02.00,0:00:02.50,Default,,0,0,0,,Keep between\nDialogue:0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Two\n";
        let mut document = parse_document(source);
        document.cues[0].end_ms = 4_000;
        document.cues[0].raw_text = "One\\NTwo".into();
        document.cues[0].text = "One\nTwo".into();
        document.cues.remove(1);

        let output = serialize_merged_document(source, &document, 0).unwrap();
        let merged = output.find("Dialogue:0,0:00:01.00,0:00:04.00").unwrap();
        let comment = output.find("Comment:0,0:00:02.00").unwrap();

        assert!(merged < comment);
        assert_eq!(output.matches("Dialogue:").count(), 1);
        assert!(output.contains("Keep between"));
    }
}
