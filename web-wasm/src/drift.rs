use super::document::{parse_document, SubtitleDocument};
use super::source_rewrite::serialize_edited_document;
use super::{push_json_string, return_json};

const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DriftAnchors {
    source_first_ms: u64,
    expected_first_ms: u64,
    source_second_ms: u64,
    expected_second_ms: u64,
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

    fn source(&mut self) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        if len > MAX_SOURCE_BYTES {
            return Err("Subtitle source exceeds the supported drift-correction size.".into());
        }
        self.take(len)
    }

    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn parse_request(bytes: &[u8]) -> Result<(&[u8], DriftAnchors), String> {
    let mut reader = Reader::new(bytes);
    let source = reader.source()?;
    let anchors = DriftAnchors {
        source_first_ms: reader.u64()?,
        expected_first_ms: reader.u64()?,
        source_second_ms: reader.u64()?,
        expected_second_ms: reader.u64()?,
    };
    if !reader.finished() {
        return Err("Drift-correction input contains trailing bytes.".into());
    }
    Ok((source, anchors))
}

fn validate_anchors(anchors: DriftAnchors) -> Result<(), String> {
    if anchors.source_second_ms <= anchors.source_first_ms {
        return Err("The second source anchor must be later than the first source anchor.".into());
    }
    if anchors.expected_second_ms <= anchors.expected_first_ms {
        return Err("The second expected anchor must be later than the first expected anchor.".into());
    }
    Ok(())
}

fn div_round_nearest(numerator: i128, denominator: i128) -> i128 {
    debug_assert!(denominator > 0);
    if numerator >= 0 {
        (numerator + denominator / 2) / denominator
    } else {
        -((-numerator + denominator / 2) / denominator)
    }
}

fn transform_time(milliseconds: u64, anchors: DriftAnchors) -> Result<u64, String> {
    let source_span = i128::from(anchors.source_second_ms) - i128::from(anchors.source_first_ms);
    let expected_span = i128::from(anchors.expected_second_ms) - i128::from(anchors.expected_first_ms);
    let source_delta = i128::from(milliseconds) - i128::from(anchors.source_first_ms);
    let scaled_delta = div_round_nearest(source_delta * expected_span, source_span);
    let transformed = i128::from(anchors.expected_first_ms) + scaled_delta;
    if transformed < 0 || transformed > i128::from(u64::MAX) {
        return Err(format!(
            "Drift correction maps {milliseconds} ms outside the supported non-negative timestamp range."
        ));
    }
    Ok(transformed as u64)
}

fn fail_on_parse_warnings(document: &SubtitleDocument) -> Result<(), String> {
    if document.warnings.is_empty() {
        return Ok(());
    }
    Err(format!(
        "This subtitle document cannot be drift-corrected losslessly because parsing reported: {}",
        document.warnings.join(" ")
    ))
}

fn serialize_all_cues(source: &[u8], document: &SubtitleDocument) -> Result<String, String> {
    let mut output = source.to_vec();
    for cue_index in 0..document.cues.len() {
        output = serialize_edited_document(&output, document, cue_index)?.into_bytes();
    }
    String::from_utf8(output)
        .map_err(|_| "Drift-corrected subtitle serialization produced invalid UTF-8.".to_string())
}

fn apply_drift(source: &[u8], anchors: DriftAnchors) -> Result<String, String> {
    validate_anchors(anchors)?;
    let mut document = parse_document(source);
    fail_on_parse_warnings(&document)?;
    let cue_count = document.cues.len();

    for cue in &mut document.cues {
        cue.start_ms = transform_time(cue.start_ms, anchors)?;
        cue.end_ms = transform_time(cue.end_ms, anchors)?;
        if cue.end_ms < cue.start_ms {
            return Err("Drift correction would invert a cue timing range.".into());
        }
    }

    let content = serialize_all_cues(source, &document)?;
    let reparsed = parse_document(content.as_bytes());
    let roundtrips = reparsed.warnings.is_empty()
        && reparsed.format == document.format
        && reparsed.cues.len() == cue_count
        && reparsed.cues.iter().zip(&document.cues).all(|(actual, expected)| {
            actual.start_ms == expected.start_ms
                && actual.end_ms == expected.end_ms
                && actual.raw_text == expected.raw_text
        });
    if !roundtrips {
        return Err("The drift-corrected document did not round-trip through the source subtitle format.".into());
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
    let result = parse_request(bytes).and_then(|(source, anchors)| apply_drift(source, anchors));
    return_json(match result {
        Ok(content) => success_json(&content),
        Err(message) => error_json(&message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchors(
        source_first_ms: u64,
        expected_first_ms: u64,
        source_second_ms: u64,
        expected_second_ms: u64,
    ) -> DriftAnchors {
        DriftAnchors {
            source_first_ms,
            expected_first_ms,
            source_second_ms,
            expected_second_ms,
        }
    }

    #[test]
    fn applies_linear_two_anchor_drift_deterministically() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:08,000 --> 00:00:09,000\nTwo\n\n";
        let output = apply_drift(source, anchors(1_000, 1_500, 9_000, 10_500)).unwrap();
        let reparsed = parse_document(output.as_bytes());

        assert_eq!((reparsed.cues[0].start_ms, reparsed.cues[0].end_ms), (1_500, 2_625));
        assert_eq!((reparsed.cues[1].start_ms, reparsed.cues[1].end_ms), (9_375, 10_500));
    }

    #[test]
    fn rounds_fractional_milliseconds_to_the_nearest_integer() {
        let mapping = anchors(0, 0, 3, 2);
        assert_eq!(transform_time(1, mapping).unwrap(), 1);
        assert_eq!(transform_time(2, mapping).unwrap(), 1);
    }

    #[test]
    fn rejects_non_monotonic_anchor_pairs() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n";
        assert!(apply_drift(source, anchors(1_000, 1_000, 1_000, 2_000)).is_err());
        assert!(apply_drift(source, anchors(1_000, 2_000, 2_000, 1_000)).is_err());
    }

    #[test]
    fn rejects_negative_extrapolation_instead_of_clamping() {
        let source = b"1\n00:00:00,000 --> 00:00:00,500\nEarly\n\n";
        let error = apply_drift(source, anchors(1_000, 0, 2_000, 1_000)).unwrap_err();
        assert!(error.contains("outside the supported non-negative timestamp range"));
    }

    #[test]
    fn preserves_interleaved_webvtt_metadata_order() {
        let source = b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n\nNOTE keep between\nowner: test\n\n00:00:03.000 --> 00:00:04.000\nTwo\n\n";
        let output = apply_drift(source, anchors(1_000, 1_500, 4_000, 5_000)).unwrap();
        let one = output.find("One").unwrap();
        let note = output.find("NOTE keep between").unwrap();
        let two = output.find("Two").unwrap();
        assert!(one < note && note < two);
        assert!(output.contains("owner: test"));
    }

    #[test]
    fn preserves_ass_non_dialogue_event_order() {
        let source = b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\nComment:0,0:00:02.00,0:00:02.50,Default,,0,0,0,,Keep between\nDialogue:0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Two\n";
        let output = apply_drift(source, anchors(1_000, 1_500, 4_000, 5_000)).unwrap();
        let one = output.find("Dialogue:0,0:00:01.50").unwrap();
        let comment = output.find("Comment:0,0:00:02.00").unwrap();
        let two = output.find("Dialogue:0,0:00:03.83").unwrap();
        assert!(one < comment && comment < two);
    }
}
