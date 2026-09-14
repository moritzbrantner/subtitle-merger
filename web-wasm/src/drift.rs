use super::document::{parse_document, DocumentFormat};
use super::source_rewrite::serialize_edited_document;
use super::{push_json_string, return_json};

const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DriftAnchors {
    source_start_ms: u64,
    expected_start_ms: u64,
    source_end_ms: u64,
    expected_end_ms: u64,
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
            .ok_or_else(|| "Drift-correction input ended unexpectedly.".to_string())?;
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

    fn blob(&mut self, max_len: usize, label: &str) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        if len > max_len {
            return Err(format!("{label} exceeds the supported drift-correction size."));
        }
        self.take(len)
    }

    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn parse_request(bytes: &[u8]) -> Result<(&[u8], DriftAnchors), String> {
    let mut reader = Reader::new(bytes);
    let source = reader.blob(MAX_SOURCE_BYTES, "Subtitle source")?;
    let anchors = DriftAnchors {
        source_start_ms: reader.u64()?,
        expected_start_ms: reader.u64()?,
        source_end_ms: reader.u64()?,
        expected_end_ms: reader.u64()?,
    };
    if !reader.finished() {
        return Err("Drift-correction input contains trailing bytes.".into());
    }
    Ok((source, anchors))
}

fn rounded_div(numerator: i128, denominator: i128) -> Result<i128, String> {
    if denominator <= 0 {
        return Err("Drift-correction denominator must be positive.".into());
    }
    let half = denominator / 2;
    if numerator >= 0 {
        numerator
            .checked_add(half)
            .map(|value| value / denominator)
            .ok_or_else(|| "Drift-correction arithmetic overflowed.".to_string())
    } else {
        numerator
            .checked_neg()
            .and_then(|value| value.checked_add(half))
            .map(|value| -(value / denominator))
            .ok_or_else(|| "Drift-correction arithmetic overflowed.".to_string())
    }
}

fn quantize_nearest(milliseconds: i128, quantum_ms: u64) -> Result<i128, String> {
    if quantum_ms <= 1 {
        return Ok(milliseconds);
    }
    let quantum = i128::from(quantum_ms);
    rounded_div(milliseconds, quantum)?.checked_mul(quantum)
        .ok_or_else(|| "Drift-correction arithmetic overflowed.".to_string())
}

fn transformed_time(
    milliseconds: u64,
    anchors: DriftAnchors,
    quantum_ms: u64,
) -> Result<u64, String> {
    let source_span = i128::from(anchors.source_end_ms - anchors.source_start_ms);
    let expected_span = i128::from(anchors.expected_end_ms - anchors.expected_start_ms);
    let delta = i128::from(milliseconds) - i128::from(anchors.source_start_ms);
    let numerator = delta
        .checked_mul(expected_span)
        .ok_or_else(|| "Drift-correction arithmetic overflowed.".to_string())?;
    let scaled = rounded_div(numerator, source_span)?;
    let transformed = i128::from(anchors.expected_start_ms)
        .checked_add(scaled)
        .ok_or_else(|| "Drift-correction arithmetic overflowed.".to_string())?;
    let transformed = quantize_nearest(transformed, quantum_ms)?;
    if transformed < 0 || transformed > i128::from(u64::MAX) {
        return Err("Drift correction would move subtitle timing outside the supported range.".into());
    }
    Ok(transformed as u64)
}

fn format_quantum(format: &DocumentFormat) -> u64 {
    match format {
        DocumentFormat::Ass | DocumentFormat::Ssa => 10,
        DocumentFormat::Srt | DocumentFormat::WebVtt => 1,
    }
}

fn validate_anchors(anchors: DriftAnchors, quantum_ms: u64) -> Result<(), String> {
    if anchors.source_end_ms <= anchors.source_start_ms {
        return Err("The second source anchor must be later than the first source anchor.".into());
    }
    if anchors.expected_end_ms <= anchors.expected_start_ms {
        return Err("The second expected anchor must be later than the first expected anchor.".into());
    }
    if quantum_ms > 1
        && (anchors.expected_start_ms % quantum_ms != 0
            || anchors.expected_end_ms % quantum_ms != 0)
    {
        return Err(format!(
            "This subtitle format represents timing in {quantum_ms} ms steps, so expected anchors must use that precision."
        ));
    }
    Ok(())
}

fn apply_drift_correction(source: &[u8], anchors: DriftAnchors) -> Result<String, String> {
    let mut document = parse_document(source);
    if !document.warnings.is_empty() {
        return Err(format!(
            "This subtitle document cannot be drift-corrected losslessly because parsing reported: {}",
            document.warnings.join(" ")
        ));
    }

    let quantum_ms = format_quantum(&document.format);
    validate_anchors(anchors, quantum_ms)?;
    let original = document.clone();

    for (cue_index, cue) in document.cues.iter_mut().enumerate() {
        let start_ms = transformed_time(cue.start_ms, anchors, quantum_ms)?;
        let end_ms = transformed_time(cue.end_ms, anchors, quantum_ms)?;
        if end_ms < start_ms {
            return Err(format!(
                "Drift correction would invert cue {} timing.",
                cue_index + 1
            ));
        }
        if cue.end_ms > cue.start_ms && end_ms == start_ms {
            return Err(format!(
                "Drift correction would collapse cue {} to zero duration.",
                cue_index + 1
            ));
        }
        cue.start_ms = start_ms;
        cue.end_ms = end_ms;
    }

    let mut content = String::from_utf8(source.to_vec())
        .map_err(|_| "Subtitle source contains invalid UTF-8 after decoding boundary.".to_string())?;
    for cue_index in 0..document.cues.len() {
        content = serialize_edited_document(content.as_bytes(), &document, cue_index)?;
    }

    let reparsed = parse_document(content.as_bytes());
    let roundtrips = reparsed.warnings.is_empty()
        && reparsed.format == document.format
        && reparsed.cues.len() == document.cues.len()
        && reparsed
            .cues
            .iter()
            .zip(document.cues.iter())
            .zip(original.cues.iter())
            .all(|((reparsed_cue, target_cue), original_cue)| {
                reparsed_cue.start_ms == target_cue.start_ms
                    && reparsed_cue.end_ms == target_cue.end_ms
                    && reparsed_cue.raw_text == original_cue.raw_text
                    && reparsed_cue.identifier == original_cue.identifier
                    && reparsed_cue.settings == original_cue.settings
            });
    if !roundtrips {
        return Err(
            "This drift correction cannot be represented losslessly in the source subtitle format."
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
pub unsafe extern "C" fn correct_subtitle_drift(ptr: u32, len: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };

    let result = parse_request(bytes)
        .and_then(|(source, anchors)| apply_drift_correction(source, anchors));
    return_json(match result {
        Ok(content) => success_json(&content),
        Err(message) => error_json(&message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchors(
        source_start_ms: u64,
        expected_start_ms: u64,
        source_end_ms: u64,
        expected_end_ms: u64,
    ) -> DriftAnchors {
        DriftAnchors {
            source_start_ms,
            expected_start_ms,
            source_end_ms,
            expected_end_ms,
        }
    }

    #[test]
    fn applies_deterministic_linear_offset_and_drift_to_srt() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:05,000 --> 00:00:06,000\nTwo\n\n3\n00:00:09,000 --> 00:00:10,000\nThree\n\n";
        let output = apply_drift_correction(source, anchors(1_000, 1_200, 9_000, 10_000)).unwrap();
        let reparsed = parse_document(output.as_bytes());

        assert_eq!((reparsed.cues[0].start_ms, reparsed.cues[0].end_ms), (1_200, 2_300));
        assert_eq!((reparsed.cues[1].start_ms, reparsed.cues[1].end_ms), (5_600, 6_700));
        assert_eq!((reparsed.cues[2].start_ms, reparsed.cues[2].end_ms), (10_000, 11_100));
    }

    #[test]
    fn extrapolates_before_and_after_the_anchor_window_without_clamping() {
        let source = b"1\n00:00:00,500 --> 00:00:01,000\nBefore\n\n2\n00:00:05,000 --> 00:00:06,000\nAfter\n\n";
        let output = apply_drift_correction(source, anchors(1_000, 1_500, 4_000, 4_800)).unwrap();
        let reparsed = parse_document(output.as_bytes());

        assert_eq!(reparsed.cues[0].start_ms, 950);
        assert_eq!(reparsed.cues[1].start_ms, 5_900);
    }

    #[test]
    fn preserves_interleaved_webvtt_metadata_while_retiming_every_cue() {
        let source = b"WEBVTT Demo\n\ncue-a\n00:00:01.000 --> 00:00:02.000 line:80%\nOne\n\nNOTE keep between\nowner: test\n\ncue-b\n00:00:03.000 --> 00:00:04.000\nTwo\n\n";
        let output = apply_drift_correction(source, anchors(1_000, 1_100, 3_000, 3_500)).unwrap();

        let first = output.find("cue-a").unwrap();
        let note = output.find("NOTE keep between").unwrap();
        let second = output.find("cue-b").unwrap();
        assert!(first < note && note < second);
        assert!(output.contains("00:00:01.100 --> 00:00:02.300 line:80%"));
        assert!(output.contains("00:00:03.500 --> 00:00:04.700"));
    }

    #[test]
    fn preserves_ass_event_order_and_uses_centisecond_precision() {
        let source = b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\nComment:0,0:00:02.00,0:00:02.50,Default,,0,0,0,,Keep between\nDialogue:0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Two\n";
        let output = apply_drift_correction(source, anchors(1_000, 1_100, 3_000, 3_500)).unwrap();

        let first = output.find("Dialogue:0,0:00:01.10").unwrap();
        let comment = output.find("Comment:0,0:00:02.00").unwrap();
        let second = output.find("Dialogue:0,0:00:03.50").unwrap();
        assert!(first < comment && comment < second);
        assert!(output.contains("Dialogue:0,0:00:01.10,0:00:02.30"));
        assert!(output.contains("Dialogue:0,0:00:03.50,0:00:04.70"));
    }

    #[test]
    fn rejects_non_monotonic_or_unrepresentable_anchors() {
        let srt = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n";
        assert!(apply_drift_correction(srt, anchors(2_000, 1_000, 1_000, 2_000)).is_err());
        assert!(apply_drift_correction(srt, anchors(1_000, 2_000, 2_000, 1_000)).is_err());

        let ass = b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\n";
        let error = apply_drift_correction(ass, anchors(1_000, 1_001, 2_000, 2_001)).unwrap_err();
        assert!(error.contains("10 ms steps"));
    }

    #[test]
    fn rejects_a_transform_that_moves_content_before_zero() {
        let source = b"1\n00:00:00,500 --> 00:00:01,000\nOne\n\n";
        let error = apply_drift_correction(source, anchors(1_000, 100, 2_000, 1_100)).unwrap_err();
        assert!(error.contains("outside the supported range"));
    }

    #[test]
    fn refuses_lossy_source_documents() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nKeep\n\nbroken block\n";
        let error = apply_drift_correction(source, anchors(1_000, 1_100, 2_000, 2_100)).unwrap_err();
        assert!(error.contains("cannot be drift-corrected losslessly"));
    }

    #[test]
    fn parser_rejects_trailing_request_bytes() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n";
        let mut request = Vec::new();
        request.extend_from_slice(&(source.len() as u32).to_le_bytes());
        request.extend_from_slice(source);
        request.extend_from_slice(&1_000_u64.to_le_bytes());
        request.extend_from_slice(&1_100_u64.to_le_bytes());
        request.extend_from_slice(&2_000_u64.to_le_bytes());
        request.extend_from_slice(&2_100_u64.to_le_bytes());
        request.push(0xff);

        assert_eq!(
            parse_request(&request).unwrap_err(),
            "Drift-correction input contains trailing bytes."
        );
    }
}
