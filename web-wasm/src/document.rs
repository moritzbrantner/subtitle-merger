use super::{clean_ass_text, decode_text, parse_timestamp, push_json_string, return_json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum DocumentFormat {
    Srt,
    WebVtt,
    Ass,
    Ssa,
}

impl DocumentFormat {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::WebVtt => "webvtt",
            Self::Ass => "ass",
            Self::Ssa => "ssa",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DocumentCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub raw_text: String,
    pub identifier: Option<String>,
    pub settings: String,
    pub ass_values: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SubtitleDocument {
    pub format: DocumentFormat,
    pub title: Option<String>,
    pub language: String,
    pub default_track: bool,
    pub forced: bool,
    pub cues: Vec<DocumentCue>,
    pub warnings: Vec<String>,
    pub vtt_header_lines: Vec<String>,
    pub vtt_blocks: Vec<String>,
    pub ass_prefix_lines: Vec<String>,
    pub ass_event_format: Vec<String>,
    pub ass_event_extras: Vec<String>,
    pub ass_suffix_lines: Vec<String>,
}

impl SubtitleDocument {
    fn empty(format: DocumentFormat) -> Self {
        Self {
            format,
            title: None,
            language: "und".into(),
            default_track: false,
            forced: false,
            cues: Vec::new(),
            warnings: Vec::new(),
            vtt_header_lines: Vec::new(),
            vtt_blocks: Vec::new(),
            ass_prefix_lines: Vec::new(),
            ass_event_format: Vec::new(),
            ass_event_extras: Vec::new(),
            ass_suffix_lines: Vec::new(),
        }
    }
}

pub(super) fn parse_document(bytes: &[u8]) -> SubtitleDocument {
    let text = normalize_newlines(&decode_text(bytes));
    parse_document_text(&text)
}

fn parse_document_text(text: &str) -> SubtitleDocument {
    let text = text.trim_start_matches('\u{feff}');
    let trimmed = text.trim_start();
    if trimmed.starts_with("WEBVTT") {
        parse_webvtt_document(text)
    } else if trimmed.contains("[Events]") || trimmed.contains("[Script Info]") {
        parse_ass_document(text)
    } else {
        parse_srt_document(text)
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn split_blocks(text: &str) -> impl Iterator<Item = &str> {
    text.split("\n\n").map(str::trim).filter(|block| !block.is_empty())
}

fn parse_timing_with_settings(line: &str) -> Option<(u64, u64, String)> {
    let (left, right) = line.split_once("-->")?;
    let start_ms = parse_timestamp(left.trim())?;
    let right = right.trim();
    let mut parts = right.split_whitespace();
    let end_ms = parse_timestamp(parts.next()?)?.max(start_ms);
    let settings = parts.collect::<Vec<_>>().join(" ");
    Some((start_ms, end_ms, settings))
}

fn parse_srt_document(text: &str) -> SubtitleDocument {
    let mut document = SubtitleDocument::empty(DocumentFormat::Srt);
    for block in split_blocks(text) {
        let lines: Vec<&str> = block.lines().collect();
        let Some(timing_index) = lines.iter().position(|line| line.contains("-->")) else {
            document
                .warnings
                .push("Skipped an SRT block without a timing line.".into());
            continue;
        };
        let Some((start_ms, end_ms, settings)) = parse_timing_with_settings(lines[timing_index]) else {
            document.warnings.push(format!(
                "Skipped an SRT cue with invalid timing: {}",
                lines[timing_index]
            ));
            continue;
        };
        let raw_text = lines[timing_index + 1..].join("\n").trim().to_string();
        if raw_text.is_empty() {
            continue;
        }
        let identifier = if timing_index == 0 {
            None
        } else {
            let value = lines[..timing_index].join("\n").trim().to_string();
            (!value.is_empty()).then_some(value)
        };
        document.cues.push(DocumentCue {
            start_ms,
            end_ms,
            text: raw_text.clone(),
            raw_text,
            identifier,
            settings,
            ass_values: Vec::new(),
        });
    }
    if document.cues.is_empty() {
        document
            .warnings
            .push("No subtitle cues were found in this file.".into());
    }
    document
}

fn parse_webvtt_document(text: &str) -> SubtitleDocument {
    let mut document = SubtitleDocument::empty(DocumentFormat::WebVtt);
    let mut sections = text.splitn(2, "\n\n");
    let header = sections.next().unwrap_or_default();
    let body = sections.next().unwrap_or_default();
    let mut header_lines = header.lines();
    if let Some(first) = header_lines.next() {
        let suffix = first
            .trim_start_matches('\u{feff}')
            .strip_prefix("WEBVTT")
            .unwrap_or_default()
            .trim();
        if !suffix.is_empty() {
            document.title = Some(suffix.to_string());
        }
    }
    document.vtt_header_lines = header_lines.map(str::to_string).collect();

    for block in split_blocks(body) {
        if block.starts_with("NOTE") || block.starts_with("STYLE") || block.starts_with("REGION") {
            document.vtt_blocks.push(block.to_string());
            continue;
        }
        let lines: Vec<&str> = block.lines().collect();
        let Some(timing_index) = lines.iter().position(|line| line.contains("-->")) else {
            document
                .warnings
                .push("Skipped a WebVTT block without a timing line.".into());
            continue;
        };
        let Some((start_ms, end_ms, settings)) = parse_timing_with_settings(lines[timing_index]) else {
            document.warnings.push(format!(
                "Skipped a WebVTT cue with invalid timing: {}",
                lines[timing_index]
            ));
            continue;
        };
        let raw_text = lines[timing_index + 1..].join("\n").trim().to_string();
        if raw_text.is_empty() {
            continue;
        }
        let identifier = if timing_index == 0 {
            None
        } else {
            let value = lines[..timing_index].join("\n").trim().to_string();
            (!value.is_empty()).then_some(value)
        };
        document.cues.push(DocumentCue {
            start_ms,
            end_ms,
            text: raw_text.clone(),
            raw_text,
            identifier,
            settings,
            ass_values: Vec::new(),
        });
    }
    if document.cues.is_empty() {
        document
            .warnings
            .push("No subtitle cues were found in this file.".into());
    }
    document
}

fn default_ass_format() -> Vec<String> {
    [
        "Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV",
        "Effect", "Text",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn field_index(fields: &[String], name: &str, fallback: usize) -> usize {
    fields
        .iter()
        .position(|field| field.trim().eq_ignore_ascii_case(name))
        .unwrap_or(fallback)
}

fn parse_ass_document(text: &str) -> SubtitleDocument {
    let format = if text.contains("ScriptType: v4.00+") {
        DocumentFormat::Ass
    } else {
        DocumentFormat::Ssa
    };
    let mut document = SubtitleDocument::empty(format);
    let mut in_events = false;
    let mut seen_events = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if trimmed.eq_ignore_ascii_case("[Events]") {
                in_events = true;
                seen_events = true;
                continue;
            }
            if in_events {
                in_events = false;
            }
            if seen_events {
                document.ass_suffix_lines.push(line.to_string());
            } else {
                document.ass_prefix_lines.push(line.to_string());
            }
            continue;
        }

        if !in_events {
            if seen_events {
                document.ass_suffix_lines.push(line.to_string());
            } else {
                document.ass_prefix_lines.push(line.to_string());
            }
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("Format:") {
            document.ass_event_format = value
                .split(',')
                .map(|field| field.trim().to_string())
                .collect();
            continue;
        }

        let Some(value) = trimmed.strip_prefix("Dialogue:") else {
            document.ass_event_extras.push(line.to_string());
            continue;
        };
        let fields = if document.ass_event_format.is_empty() {
            default_ass_format()
        } else {
            document.ass_event_format.clone()
        };
        let start_index = field_index(&fields, "Start", 1);
        let end_index = field_index(&fields, "End", 2);
        let text_index = field_index(&fields, "Text", fields.len().saturating_sub(1));
        let needed = fields.len().max(text_index + 1).max(end_index + 1).max(start_index + 1);
        let values: Vec<String> = value.splitn(needed, ',').map(str::to_string).collect();
        if values.len() <= start_index || values.len() <= end_index || values.len() <= text_index {
            document
                .warnings
                .push("Skipped a malformed ASS/SSA dialogue row.".into());
            continue;
        }
        let Some(start_ms) = parse_timestamp(values[start_index].trim()) else {
            document
                .warnings
                .push("Skipped an ASS/SSA cue with invalid start time.".into());
            continue;
        };
        let Some(end_ms) = parse_timestamp(values[end_index].trim()) else {
            document
                .warnings
                .push("Skipped an ASS/SSA cue with invalid end time.".into());
            continue;
        };
        let raw_text = values[text_index].clone();
        let plain_text = clean_ass_text(raw_text.trim());
        if plain_text.is_empty() && raw_text.trim().is_empty() {
            continue;
        }
        document.cues.push(DocumentCue {
            start_ms,
            end_ms: end_ms.max(start_ms),
            text: plain_text,
            raw_text,
            identifier: None,
            settings: String::new(),
            ass_values: values,
        });
    }

    if document.ass_event_format.is_empty() {
        document.ass_event_format = default_ass_format();
    }
    if document.cues.is_empty() {
        document
            .warnings
            .push("No subtitle cues were found in this file.".into());
    }
    document
}

pub(super) fn serialize_document(document: &SubtitleDocument) -> String {
    match document.format {
        DocumentFormat::Srt => serialize_srt(document),
        DocumentFormat::WebVtt => serialize_webvtt(document),
        DocumentFormat::Ass | DocumentFormat::Ssa => serialize_ass(document),
    }
}

fn serialize_srt(document: &SubtitleDocument) -> String {
    let mut output = String::new();
    for (index, cue) in document.cues.iter().enumerate() {
        if let Some(identifier) = &cue.identifier {
            output.push_str(identifier);
        } else {
            output.push_str(&(index + 1).to_string());
        }
        output.push('\n');
        output.push_str(&format_srt_time(cue.start_ms));
        output.push_str(" --> ");
        output.push_str(&format_srt_time(cue.end_ms));
        if !cue.settings.is_empty() {
            output.push(' ');
            output.push_str(&cue.settings);
        }
        output.push('\n');
        output.push_str(&cue.raw_text);
        output.push_str("\n\n");
    }
    output
}

fn serialize_webvtt(document: &SubtitleDocument) -> String {
    let mut output = String::from("WEBVTT");
    if let Some(title) = &document.title {
        if !title.is_empty() {
            output.push(' ');
            output.push_str(title);
        }
    }
    output.push('\n');
    for line in &document.vtt_header_lines {
        output.push_str(line);
        output.push('\n');
    }
    output.push('\n');
    for block in &document.vtt_blocks {
        output.push_str(block);
        output.push_str("\n\n");
    }
    for cue in &document.cues {
        if let Some(identifier) = &cue.identifier {
            output.push_str(identifier);
            output.push('\n');
        }
        output.push_str(&format_vtt_time(cue.start_ms));
        output.push_str(" --> ");
        output.push_str(&format_vtt_time(cue.end_ms));
        if !cue.settings.is_empty() {
            output.push(' ');
            output.push_str(&cue.settings);
        }
        output.push('\n');
        output.push_str(&cue.raw_text);
        output.push_str("\n\n");
    }
    output
}

fn serialize_ass(document: &SubtitleDocument) -> String {
    let mut output = String::new();
    for line in &document.ass_prefix_lines {
        output.push_str(line);
        output.push('\n');
    }
    output.push_str("[Events]\n");
    output.push_str("Format: ");
    output.push_str(&document.ass_event_format.join(", "));
    output.push('\n');
    let start_index = field_index(&document.ass_event_format, "Start", 1);
    let end_index = field_index(&document.ass_event_format, "End", 2);
    let text_index = field_index(
        &document.ass_event_format,
        "Text",
        document.ass_event_format.len().saturating_sub(1),
    );
    for cue in &document.cues {
        let mut values = cue.ass_values.clone();
        if values.len() < document.ass_event_format.len() {
            values.resize(document.ass_event_format.len(), String::new());
        }
        if start_index < values.len() {
            values[start_index] = format_ass_time(cue.start_ms);
        }
        if end_index < values.len() {
            values[end_index] = format_ass_time(cue.end_ms);
        }
        if text_index < values.len() {
            values[text_index] = cue.raw_text.clone();
        }
        output.push_str("Dialogue:");
        output.push_str(&values.join(","));
        output.push('\n');
    }
    for line in &document.ass_event_extras {
        output.push_str(line);
        output.push('\n');
    }
    for line in &document.ass_suffix_lines {
        output.push_str(line);
        output.push('\n');
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

fn push_json_option(output: &mut String, value: Option<&str>) {
    if let Some(value) = value {
        push_json_string(output, value);
    } else {
        output.push_str("null");
    }
}

fn push_json_string_array(output: &mut String, values: &[String]) {
    output.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_json_string(output, value);
    }
    output.push(']');
}

fn document_json(document: &SubtitleDocument) -> String {
    let mut output = String::from("{\"format\":");
    push_json_string(&mut output, document.format.as_str());
    output.push_str(",\"title\":");
    push_json_option(&mut output, document.title.as_deref());
    output.push_str(",\"language\":");
    push_json_string(&mut output, &document.language);
    output.push_str(&format!(
        ",\"default\":{},\"forced\":{},\"cues\":[",
        document.default_track, document.forced
    ));
    for (index, cue) in document.cues.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&format!(
            "{{\"startMs\":{},\"endMs\":{},\"text\":",
            cue.start_ms, cue.end_ms
        ));
        push_json_string(&mut output, &cue.text);
        output.push_str(",\"rawText\":");
        push_json_string(&mut output, &cue.raw_text);
        output.push_str(",\"identifier\":");
        push_json_option(&mut output, cue.identifier.as_deref());
        output.push_str(",\"settings\":");
        push_json_string(&mut output, &cue.settings);
        output.push_str(",\"assValues\":");
        push_json_string_array(&mut output, &cue.ass_values);
        output.push('}');
    }
    output.push_str("],\"warnings\":");
    push_json_string_array(&mut output, &document.warnings);
    output.push_str(",\"metadata\":{\"vttHeaderLines\":");
    push_json_string_array(&mut output, &document.vtt_header_lines);
    output.push_str(",\"vttBlocks\":");
    push_json_string_array(&mut output, &document.vtt_blocks);
    output.push_str(",\"assPrefixLines\":");
    push_json_string_array(&mut output, &document.ass_prefix_lines);
    output.push_str(",\"assEventFormat\":");
    push_json_string_array(&mut output, &document.ass_event_format);
    output.push_str(",\"assEventExtras\":");
    push_json_string_array(&mut output, &document.ass_event_extras);
    output.push_str(",\"assSuffixLines\":");
    push_json_string_array(&mut output, &document.ass_suffix_lines);
    output.push_str("}}");
    output
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_subtitle_document(ptr: u32, len: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    return_json(document_json(&parse_document(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(input: &str) -> (SubtitleDocument, SubtitleDocument, String) {
        let first = parse_document_text(input);
        let serialized = serialize_document(&first);
        let second = parse_document_text(&serialized);
        (first, second, serialized)
    }

    #[test]
    fn srt_roundtrip_preserves_identifier_settings_and_text() {
        let input = "42\n00:00:01,250 --> 00:00:03,500 X1:10 X2:200\nHello <i>world</i>\nsecond line\n";
        let (first, second, serialized) = roundtrip(input);
        assert_eq!(first.format, DocumentFormat::Srt);
        assert_eq!(first.cues, second.cues);
        assert!(serialized.contains("X1:10 X2:200"));
        assert_eq!(second.cues[0].identifier.as_deref(), Some("42"));
        assert_eq!(second.cues[0].raw_text, "Hello <i>world</i>\nsecond line");
    }

    #[test]
    fn webvtt_roundtrip_preserves_header_blocks_ids_and_settings() {
        let input = "WEBVTT Demo\nKind: captions\nLanguage: en\n\nSTYLE\n::cue { color: lime }\n\nNOTE retained metadata\nowner: test\n\ncue-7\n00:00:01.000 --> 00:00:02.250 line:90% position:50%\n<v Jane>Hello</v>\n";
        let (first, second, serialized) = roundtrip(input);
        assert_eq!(first.format, DocumentFormat::WebVtt);
        assert_eq!(first.title, second.title);
        assert_eq!(first.vtt_header_lines, second.vtt_header_lines);
        assert_eq!(first.vtt_blocks, second.vtt_blocks);
        assert_eq!(first.cues, second.cues);
        assert!(serialized.contains("line:90% position:50%"));
    }

    #[test]
    fn ass_roundtrip_preserves_styles_override_text_and_event_fields() {
        let input = "[Script Info]\nScriptType: v4.00+\nTitle: Demo\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\nStyle: Top,Arial,42,&H00FFFFFF,8\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:1,0:00:01.00,0:00:03.50,Top,Jane,0010,0020,0030,fx,{\\i1}Hello\\Nworld\n";
        let (first, second, serialized) = roundtrip(input);
        assert_eq!(first.format, DocumentFormat::Ass);
        assert_eq!(first.ass_prefix_lines, second.ass_prefix_lines);
        assert_eq!(first.ass_event_format, second.ass_event_format);
        assert_eq!(first.cues, second.cues);
        assert!(serialized.contains("Style: Top,Arial,42,&H00FFFFFF,8"));
        assert!(serialized.contains("{\\i1}Hello\\Nworld"));
        assert_eq!(second.cues[0].text, "Hello\nworld");
        assert_eq!(second.cues[0].ass_values[3], "Top");
        assert_eq!(second.cues[0].ass_values[4], "Jane");
        assert_eq!(second.cues[0].ass_values[8], "fx");
    }
}
