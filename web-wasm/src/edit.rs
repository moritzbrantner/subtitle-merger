use super::{clean_ass_text, push_json_string, return_json};
use super::document::{parse_document, serialize_document, DocumentFormat};

const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CUE_TEXT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct CueEdit {
    cue_index: usize,
    start_ms: u64,
    end_ms: u64,
    raw_text: String,
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
            .ok_or_else(|| "Cue edit input ended unexpectedly.".to_string())?;
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
            return Err(format!("{label} exceeds the supported edit size."));
        }
        self.take(len)
    }

    fn string(&mut self, max_len: usize, label: &str) -> Result<String, String> {
        String::from_utf8(self.blob(max_len, label)?.to_vec())
            .map_err(|_| format!("{label} contains invalid UTF-8."))
    }

    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn parse_request(bytes: &[u8]) -> Result<(&[u8], CueEdit), String> {
    let mut reader = Reader::new(bytes);
    let source = reader.blob(MAX_SOURCE_BYTES, "Subtitle source")?;
    let cue_index = reader.u32()? as usize;
    let start_ms = reader.u64()?;
    let end_ms = reader.u64()?;
    let raw_text = reader.string(MAX_CUE_TEXT_BYTES, "Cue text")?;
    if !reader.finished() {
        return Err("Cue edit input contains trailing bytes.".into());
    }
    Ok((
        source,
        CueEdit {
            cue_index,
            start_ms,
            end_ms,
            raw_text,
        },
    ))
}

fn apply_edit(source: &[u8], edit: &CueEdit) -> Result<String, String> {
    if edit.end_ms < edit.start_ms {
        return Err("Cue end time must be greater than or equal to its start time.".into());
    }
    if edit.raw_text.trim().is_empty() {
        return Err("Cue text must not be empty.".into());
    }

    let mut document = parse_document(source);
    let format = document.format.clone();
    let cue_count = document.cues.len();
    let cue = document.cues.get_mut(edit.cue_index).ok_or_else(|| {
        format!(
            "Cue index {} is outside the document's {} cues.",
            edit.cue_index, cue_count
        )
    })?;

    cue.start_ms = edit.start_ms;
    cue.end_ms = edit.end_ms;
    cue.raw_text = edit.raw_text.clone();
    cue.text = match format {
        DocumentFormat::Ass | DocumentFormat::Ssa => clean_ass_text(edit.raw_text.trim()),
        DocumentFormat::Srt | DocumentFormat::WebVtt => edit.raw_text.clone(),
    };

    Ok(serialize_document(&document))
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
pub unsafe extern "C" fn edit_subtitle_document(ptr: u32, len: u32) -> u64 {
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };

    let result = parse_request(bytes).and_then(|(source, edit)| apply_edit(source, &edit));
    return_json(match result {
        Ok(content) => success_json(&content),
        Err(message) => error_json(&message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(index: usize, start_ms: u64, end_ms: u64, raw_text: &str) -> CueEdit {
        CueEdit {
            cue_index: index,
            start_ms,
            end_ms,
            raw_text: raw_text.into(),
        }
    }

    #[test]
    fn edits_srt_without_losing_identifier_or_settings() {
        let source = b"intro\n00:00:01,000 --> 00:00:02,000 position:10%\nHello\n\n";
        let output = apply_edit(source, &edit(0, 1_250, 2_750, "Hello edited")).unwrap();

        assert_eq!(
            output,
            "intro\n00:00:01,250 --> 00:00:02,750 position:10%\nHello edited\n\n"
        );
        let reparsed = parse_document(output.as_bytes());
        assert_eq!(reparsed.cues.len(), 1);
        assert_eq!(reparsed.cues[0].identifier.as_deref(), Some("intro"));
        assert_eq!(reparsed.cues[0].settings, "position:10%");
    }

    #[test]
    fn edits_webvtt_without_losing_header_blocks_or_cue_settings() {
        let source = b"WEBVTT Demo\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\nNOTE keep me\n\ncue-a\n00:00:01.000 --> 00:00:02.000 line:80%\nHello\n\n";
        let output = apply_edit(source, &edit(0, 1_100, 2_400, "Edited <i>text</i>")).unwrap();

        assert!(output.contains("WEBVTT Demo"));
        assert!(output.contains("X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000"));
        assert!(output.contains("NOTE keep me"));
        assert!(output.contains("cue-a\n00:00:01.100 --> 00:00:02.400 line:80%"));
        assert!(output.contains("Edited <i>text</i>"));
    }

    #[test]
    fn edits_ass_without_losing_script_styles_or_event_columns() {
        let source = b"[Script Info]\nTitle: Demo\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue:2,0:00:01.00,0:00:02.00,Default,Speaker,0010,0020,0030,banner,{\\i1}Hello{\\i0}\n";
        let output = apply_edit(
            source,
            &edit(0, 1_500, 2_500, "{\\i1}Edited{\\i0}\\NSecond line"),
        )
        .unwrap();

        assert!(output.contains("Title: Demo"));
        assert!(output.contains("Style: Default,Arial,20"));
        assert!(output.contains("Dialogue:2,0:00:01.50,0:00:02.50,Default,Speaker,0010,0020,0030,banner,{\\i1}Edited{\\i0}\\NSecond line"));
        let reparsed = parse_document(output.as_bytes());
        assert_eq!(reparsed.cues[0].text, "Edited\nSecond line");
    }

    #[test]
    fn rejects_invalid_edit_instead_of_coercing_it() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nHello\n\n";
        assert!(apply_edit(source, &edit(0, 3_000, 2_000, "Hello")).is_err());
        assert!(apply_edit(source, &edit(2, 1_000, 2_000, "Hello")).is_err());
        assert!(apply_edit(source, &edit(0, 1_000, 2_000, "   ")).is_err());
    }

    #[test]
    fn parser_rejects_trailing_request_bytes() {
        let source = b"1\n00:00:01,000 --> 00:00:02,000\nHello\n\n";
        let raw_text = b"Edited";
        let mut request = Vec::new();
        request.extend_from_slice(&(source.len() as u32).to_le_bytes());
        request.extend_from_slice(source);
        request.extend_from_slice(&0_u32.to_le_bytes());
        request.extend_from_slice(&1_000_u64.to_le_bytes());
        request.extend_from_slice(&2_000_u64.to_le_bytes());
        request.extend_from_slice(&(raw_text.len() as u32).to_le_bytes());
        request.extend_from_slice(raw_text);
        request.push(0xff);

        assert_eq!(
            parse_request(&request).unwrap_err(),
            "Cue edit input contains trailing bytes."
        );
    }
}
