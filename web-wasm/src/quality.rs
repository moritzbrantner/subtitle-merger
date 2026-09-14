use super::document::{parse_document, DocumentCue, SubtitleDocument};
use super::{push_json_string, return_json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct QualityProfile {
    name: &'static str,
    max_characters_per_second: u32,
    max_characters_per_line: u32,
    max_lines: u32,
    min_duration_ms: u64,
    max_duration_ms: u64,
    min_gap_ms: u64,
}

const GENERAL_READABLE_V1: QualityProfile = QualityProfile {
    name: "general-readable-v1",
    max_characters_per_second: 20,
    max_characters_per_line: 42,
    max_lines: 2,
    min_duration_ms: 800,
    max_duration_ms: 7_000,
    min_gap_ms: 80,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct QualityDiagnostic {
    code: &'static str,
    severity: &'static str,
    cue_index: usize,
    related_cue_index: Option<usize>,
    message: String,
}

fn strip_angle_markup(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut in_tag = false;
    for character in text.chars() {
        match character {
            '<' if !in_tag => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    output
}

fn visible_lines(cue: &DocumentCue) -> Vec<String> {
    cue.text.lines().map(strip_angle_markup).collect()
}

fn visible_text(cue: &DocumentCue) -> String {
    visible_lines(cue).join("\n")
}

fn visible_character_count(cue: &DocumentCue) -> usize {
    visible_text(cue)
        .chars()
        .filter(|character| *character != '\n' && *character != '\r')
        .count()
}

fn has_suspicious_whitespace(lines: &[String]) -> bool {
    lines.iter().any(|line| {
        line.trim() != line
            || line.contains("  ")
            || line.contains('\t')
            || line.contains('\u{00a0}')
    })
}

fn normalized_visible_text(cue: &DocumentCue) -> String {
    visible_text(cue)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn analyze_document(document: &SubtitleDocument, profile: QualityProfile) -> Vec<QualityDiagnostic> {
    let mut diagnostics = Vec::new();

    for (cue_index, cue) in document.cues.iter().enumerate() {
        let duration_ms = cue.end_ms.saturating_sub(cue.start_ms);
        if duration_ms < profile.min_duration_ms {
            diagnostics.push(QualityDiagnostic {
                code: "duration-too-short",
                severity: "warning",
                cue_index,
                related_cue_index: None,
                message: format!("Duration is {duration_ms} ms; the profile minimum is {} ms.", profile.min_duration_ms),
            });
        }
        if duration_ms > profile.max_duration_ms {
            diagnostics.push(QualityDiagnostic {
                code: "duration-too-long",
                severity: "warning",
                cue_index,
                related_cue_index: None,
                message: format!("Duration is {duration_ms} ms; the profile maximum is {} ms.", profile.max_duration_ms),
            });
        }

        let character_count = visible_character_count(cue) as u64;
        if duration_ms > 0
            && character_count.saturating_mul(1_000)
                > u64::from(profile.max_characters_per_second).saturating_mul(duration_ms)
        {
            let tenths = character_count.saturating_mul(10_000) / duration_ms;
            diagnostics.push(QualityDiagnostic {
                code: "reading-speed-high",
                severity: "warning",
                cue_index,
                related_cue_index: None,
                message: format!("Reading speed is {}.{} characters/s; the profile maximum is {} characters/s.", tenths / 10, tenths % 10, profile.max_characters_per_second),
            });
        }

        let lines = visible_lines(cue);
        if lines.len() > profile.max_lines as usize {
            diagnostics.push(QualityDiagnostic {
                code: "too-many-lines",
                severity: "warning",
                cue_index,
                related_cue_index: None,
                message: format!("Cue has {} lines; the profile maximum is {}.", lines.len(), profile.max_lines),
            });
        }
        let longest_line = lines.iter().map(|line| line.trim().chars().count()).max().unwrap_or_default();
        if longest_line > profile.max_characters_per_line as usize {
            diagnostics.push(QualityDiagnostic {
                code: "line-too-long",
                severity: "warning",
                cue_index,
                related_cue_index: None,
                message: format!("Longest line has {longest_line} characters; the profile maximum is {}.", profile.max_characters_per_line),
            });
        }
        if has_suspicious_whitespace(&lines) {
            diagnostics.push(QualityDiagnostic {
                code: "suspicious-whitespace",
                severity: "warning",
                cue_index,
                related_cue_index: None,
                message: "Cue contains leading/trailing, repeated, tab, or non-breaking whitespace.".into(),
            });
        }
    }

    for cue_index in 0..document.cues.len().saturating_sub(1) {
        let cue = &document.cues[cue_index];
        let next = &document.cues[cue_index + 1];
        if next.start_ms < cue.start_ms {
            diagnostics.push(QualityDiagnostic {
                code: "out-of-order",
                severity: "warning",
                cue_index,
                related_cue_index: Some(cue_index + 1),
                message: "The following cue starts before this cue, so source cue order is not chronological.".into(),
            });
        }
        if next.start_ms < cue.end_ms {
            diagnostics.push(QualityDiagnostic {
                code: "overlap",
                severity: "warning",
                cue_index,
                related_cue_index: Some(cue_index + 1),
                message: format!("The following cue starts {} ms before this cue ends.", cue.end_ms - next.start_ms),
            });
        } else {
            let gap_ms = next.start_ms - cue.end_ms;
            if gap_ms < profile.min_gap_ms {
                diagnostics.push(QualityDiagnostic {
                    code: "gap-too-short",
                    severity: "warning",
                    cue_index,
                    related_cue_index: Some(cue_index + 1),
                    message: format!("Gap to the following cue is {gap_ms} ms; the profile minimum is {} ms.", profile.min_gap_ms),
                });
            }
        }

        let normalized = normalized_visible_text(cue);
        if !normalized.is_empty() && normalized == normalized_visible_text(next) {
            diagnostics.push(QualityDiagnostic {
                code: "duplicate-adjacent-text",
                severity: "warning",
                cue_index,
                related_cue_index: Some(cue_index + 1),
                message: "This cue and the following cue contain the same visible text.".into(),
            });
        }
    }

    diagnostics
}

fn push_profile_json(output: &mut String, profile: QualityProfile) {
    output.push_str("{\"name\":");
    push_json_string(output, profile.name);
    output.push_str(&format!(",\"maxCharactersPerSecond\":{},\"maxCharactersPerLine\":{},\"maxLines\":{},\"minDurationMs\":{},\"maxDurationMs\":{},\"minGapMs\":{}}}", profile.max_characters_per_second, profile.max_characters_per_line, profile.max_lines, profile.min_duration_ms, profile.max_duration_ms, profile.min_gap_ms));
}

fn push_diagnostic_json(output: &mut String, diagnostic: &QualityDiagnostic) {
    output.push_str("{\"code\":");
    push_json_string(output, diagnostic.code);
    output.push_str(",\"severity\":");
    push_json_string(output, diagnostic.severity);
    output.push_str(&format!(",\"cueIndex\":{}", diagnostic.cue_index));
    output.push_str(",\"relatedCueIndex\":");
    if let Some(index) = diagnostic.related_cue_index {
        output.push_str(&index.to_string());
    } else {
        output.push_str("null");
    }
    output.push_str(",\"message\":");
    push_json_string(output, &diagnostic.message);
    output.push('}');
}

fn quality_report_json(document: &SubtitleDocument) -> String {
    let profile = GENERAL_READABLE_V1;
    let diagnostics = analyze_document(document, profile);
    let mut output = String::from("{\"profile\":");
    push_profile_json(&mut output, profile);
    output.push_str(&format!(",\"analyzedCueCount\":{},\"diagnostics\":[", document.cues.len()));
    for (index, diagnostic) in diagnostics.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_diagnostic_json(&mut output, diagnostic);
    }
    output.push_str("]}");
    output
}

fn error_json(message: &str) -> String {
    let mut output = String::from("{\"error\":");
    push_json_string(&mut output, message);
    output.push('}');
    output
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn analyze_subtitle_quality(ptr: u32, len: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) } };
    let document = parse_document(bytes);
    if !document.warnings.is_empty() {
        return return_json(error_json(&format!("Quality analysis requires a lossless source document: {}", document.warnings.join(" "))));
    }
    return_json(quality_report_json(&document))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(input: &str) -> Vec<&'static str> {
        let document = parse_document(input.as_bytes());
        analyze_document(&document, GENERAL_READABLE_V1).into_iter().map(|diagnostic| diagnostic.code).collect()
    }

    #[test]
    fn reports_readability_duration_line_and_whitespace_findings() {
        let input = "1\n00:00:00,000 --> 00:00:00,400\nThis line is intentionally far too long for a short cue with  double spacing.\n\n2\n00:00:00,450 --> 00:00:09,000\nOne\nTwo\nThree\n";
        let findings = codes(input);
        assert!(findings.contains(&"duration-too-short"));
        assert!(findings.contains(&"reading-speed-high"));
        assert!(findings.contains(&"line-too-long"));
        assert!(findings.contains(&"suspicious-whitespace"));
        assert!(findings.contains(&"duration-too-long"));
        assert!(findings.contains(&"too-many-lines"));
        assert!(findings.contains(&"gap-too-short"));
    }

    #[test]
    fn reports_overlap_order_and_duplicate_adjacent_text() {
        let input = "1\n00:00:02,000 --> 00:00:04,000\nSame text\n\n2\n00:00:01,500 --> 00:00:03,000\nSame   text\n";
        let findings = codes(input);
        assert!(findings.contains(&"out-of-order"));
        assert!(findings.contains(&"overlap"));
        assert!(findings.contains(&"duplicate-adjacent-text"));
    }

    #[test]
    fn formatting_tags_do_not_inflate_readability_character_counts() {
        let input = "1\n00:00:00,000 --> 00:00:02,000\n<i>1234567890123456789012345678901234567890</i>\n";
        let findings = codes(input);
        assert!(!findings.contains(&"line-too-long"));
        assert!(!findings.contains(&"reading-speed-high"));
    }

    #[test]
    fn malformed_source_is_not_treated_as_analyzable() {
        let document = parse_document(b"this is not a subtitle document");
        assert!(!document.warnings.is_empty());
    }
}
