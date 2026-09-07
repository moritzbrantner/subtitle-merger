use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cue {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubtitleTrack {
    id: String,
    title: String,
    language: String,
    format: String,
    codec: String,
    forced: bool,
    cues: Vec<Cue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnsupportedTrack {
    title: String,
    language: String,
    codec: String,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VideoInspection {
    container: String,
    duration_ms: Option<u64>,
    tracks: Vec<SubtitleTrack>,
    unsupported: Vec<UnsupportedTrack>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSubtitle {
    format: String,
    cues: Vec<Cue>,
    warnings: Vec<String>,
}

#[unsafe(no_mangle)]
pub extern "C" fn allocate(len: u32) -> u32 {
    if len == 0 {
        return 0;
    }

    let bytes = vec![0_u8; len as usize].into_boxed_slice();
    Box::into_raw(bytes) as *mut u8 as u32
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn deallocate(ptr: u32, len: u32) {
    if ptr == 0 || len == 0 {
        return;
    }

    let slice = std::ptr::slice_from_raw_parts_mut(ptr as *mut u8, len as usize);
    unsafe {
        drop(Box::from_raw(slice));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn inspect_video(ptr: u32, len: u32) -> u64 {
    let bytes = unsafe { input_bytes(ptr, len) };
    let inspection = inspect_video_bytes(bytes);
    return_json(video_inspection_json(&inspection))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_subtitle(ptr: u32, len: u32) -> u64 {
    let bytes = unsafe { input_bytes(ptr, len) };
    let parsed = parse_subtitle_bytes(bytes);
    return_json(parsed_subtitle_json(&parsed))
}

unsafe fn input_bytes<'a>(ptr: u32, len: u32) -> &'a [u8] {
    if ptr == 0 || len == 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
}

fn return_json(json: String) -> u64 {
    let bytes = json.into_bytes().into_boxed_slice();
    let len = bytes.len() as u32;
    let ptr = Box::into_raw(bytes) as *mut u8 as u32;
    ((len as u64) << 32) | ptr as u64
}

fn inspect_video_bytes(bytes: &[u8]) -> VideoInspection {
    if looks_like_mp4(bytes) {
        inspect_mp4(bytes)
    } else if looks_like_matroska(bytes) {
        inspect_matroska(bytes)
    } else {
        VideoInspection {
            container: "unknown".into(),
            duration_ms: None,
            tracks: Vec::new(),
            unsupported: Vec::new(),
            warnings: vec![
                "This browser build currently extracts embedded text subtitles from MP4/MOV and Matroska/WebM containers.".into(),
            ],
        }
    }
}

fn parse_subtitle_bytes(bytes: &[u8]) -> ParsedSubtitle {
    let text = decode_text(bytes);
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim_start_matches('\u{feff}');

    if trimmed.trim_start().starts_with("WEBVTT") {
        parse_webvtt(trimmed)
    } else if trimmed.contains("[Events]") || trimmed.contains("[Script Info]") {
        parse_ass(trimmed)
    } else {
        parse_srt(trimmed)
    }
}

fn parse_srt(text: &str) -> ParsedSubtitle {
    let mut cues = Vec::new();
    let mut warnings = Vec::new();

    for block in split_blocks(text) {
        let lines: Vec<&str> = block.lines().collect();
        if lines.is_empty() {
            continue;
        }
        let timing_index = lines.iter().position(|line| line.contains("-->"));
        let Some(timing_index) = timing_index else {
            continue;
        };
        let Some((start_ms, end_ms)) = parse_timing_line(lines[timing_index]) else {
            warnings.push(format!("Skipped an SRT cue with invalid timing: {}", lines[timing_index]));
            continue;
        };
        let text = lines[timing_index + 1..].join("\n").trim().to_string();
        if !text.is_empty() {
            cues.push(Cue {
                start_ms,
                end_ms: end_ms.max(start_ms),
                text,
            });
        }
    }

    if cues.is_empty() {
        warnings.push("No subtitle cues were found in this file.".into());
    }

    ParsedSubtitle {
        format: "srt".into(),
        cues,
        warnings,
    }
}

fn parse_webvtt(text: &str) -> ParsedSubtitle {
    let body = text
        .trim_start_matches('\u{feff}')
        .strip_prefix("WEBVTT")
        .unwrap_or(text)
        .trim_start_matches(|c| c == ' ' || c == '\t' || c == '\n');
    let mut cues = Vec::new();
    let mut warnings = Vec::new();

    for block in split_blocks(body) {
        if block.starts_with("NOTE") || block.starts_with("STYLE") || block.starts_with("REGION") {
            continue;
        }
        let lines: Vec<&str> = block.lines().collect();
        let timing_index = lines.iter().position(|line| line.contains("-->"));
        let Some(timing_index) = timing_index else {
            continue;
        };
        let Some((start_ms, end_ms)) = parse_timing_line(lines[timing_index]) else {
            warnings.push(format!("Skipped a WebVTT cue with invalid timing: {}", lines[timing_index]));
            continue;
        };
        let text = lines[timing_index + 1..].join("\n").trim().to_string();
        if !text.is_empty() {
            cues.push(Cue {
                start_ms,
                end_ms: end_ms.max(start_ms),
                text,
            });
        }
    }

    if cues.is_empty() {
        warnings.push("No subtitle cues were found in this file.".into());
    }

    ParsedSubtitle {
        format: "webvtt".into(),
        cues,
        warnings,
    }
}

fn parse_ass(text: &str) -> ParsedSubtitle {
    let mut in_events = false;
    let mut fields: Vec<String> = Vec::new();
    let mut cues = Vec::new();
    let mut warnings = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_events = trimmed.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Format:") {
            fields = value
                .split(',')
                .map(|field| field.trim().to_ascii_lowercase())
                .collect();
            continue;
        }
        let Some(value) = trimmed.strip_prefix("Dialogue:") else {
            continue;
        };

        let start_index = fields.iter().position(|field| field == "start").unwrap_or(1);
        let end_index = fields.iter().position(|field| field == "end").unwrap_or(2);
        let text_index = fields
            .iter()
            .position(|field| field == "text")
            .unwrap_or_else(|| fields.len().saturating_sub(1).max(9));
        let needed = text_index.max(start_index).max(end_index) + 1;
        let values: Vec<&str> = value.splitn(needed, ',').collect();
        if values.len() <= text_index || values.len() <= end_index || values.len() <= start_index {
            warnings.push("Skipped a malformed ASS/SSA dialogue row.".into());
            continue;
        }
        let Some(start_ms) = parse_timestamp(values[start_index].trim()) else {
            warnings.push("Skipped an ASS/SSA cue with invalid start time.".into());
            continue;
        };
        let Some(end_ms) = parse_timestamp(values[end_index].trim()) else {
            warnings.push("Skipped an ASS/SSA cue with invalid end time.".into());
            continue;
        };
        let text = clean_ass_text(values[text_index].trim());
        if !text.is_empty() {
            cues.push(Cue {
                start_ms,
                end_ms: end_ms.max(start_ms),
                text,
            });
        }
    }

    if cues.is_empty() {
        warnings.push("No subtitle cues were found in this file.".into());
    }

    ParsedSubtitle {
        format: if text.contains("ScriptType: v4.00+") {
            "ass".into()
        } else {
            "ssa".into()
        },
        cues,
        warnings,
    }
}

fn split_blocks(text: &str) -> impl Iterator<Item = &str> {
    text.split("\n\n").map(str::trim).filter(|block| !block.is_empty())
}

fn parse_timing_line(line: &str) -> Option<(u64, u64)> {
    let (left, right) = line.split_once("-->")?;
    let start = parse_timestamp(left.trim())?;
    let right_time = right.split_whitespace().next()?;
    let end = parse_timestamp(right_time.trim())?;
    Some((start, end))
}

fn parse_timestamp(value: &str) -> Option<u64> {
    let value = value.trim().replace(',', ".");
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }

    let (hours, minutes, seconds_part) = if parts.len() == 3 {
        (parts[0].parse::<u64>().ok()?, parts[1].parse::<u64>().ok()?, parts[2])
    } else {
        (0, parts[0].parse::<u64>().ok()?, parts[1])
    };
    let (seconds_text, fraction_text) = seconds_part.split_once('.').unwrap_or((seconds_part, ""));
    let seconds = seconds_text.parse::<u64>().ok()?;
    let fraction_digits: String = fraction_text.chars().take(3).collect();
    let millis = if fraction_digits.is_empty() {
        0
    } else {
        let value = fraction_digits.parse::<u64>().ok()?;
        match fraction_digits.len() {
            1 => value * 100,
            2 => value * 10,
            _ => value,
        }
    };
    Some((((hours * 60 + minutes) * 60 + seconds) * 1000) + millis)
}

fn clean_ass_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut in_tag = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' => in_tag = true,
            '}' if in_tag => in_tag = false,
            '\\' if !in_tag => match chars.peek().copied() {
                Some('N') | Some('n') => {
                    chars.next();
                    output.push('\n');
                }
                Some('h') => {
                    chars.next();
                    output.push(' ');
                }
                _ => output.push(ch),
            },
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output.trim().to_string()
}

fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn looks_like_mp4(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && (&bytes[4..8] == b"ftyp" || &bytes[4..8] == b"moov")
}

fn looks_like_matroska(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
}

#[derive(Debug, Clone, Copy)]
struct Mp4Box {
    kind: [u8; 4],
    payload_start: usize,
    end: usize,
}

fn mp4_boxes(bytes: &[u8], start: usize, end: usize) -> Vec<Mp4Box> {
    let mut boxes = Vec::new();
    let mut offset = start;
    let end = end.min(bytes.len());

    while offset + 8 <= end {
        let size32 = be_u32(bytes, offset).unwrap_or(0) as u64;
        let kind = [bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]];
        let (size, header) = if size32 == 1 {
            let Some(size64) = be_u64(bytes, offset + 8) else { break };
            (size64, 16_usize)
        } else if size32 == 0 {
            ((end - offset) as u64, 8_usize)
        } else {
            (size32, 8_usize)
        };
        if size < header as u64 || size > usize::MAX as u64 {
            break;
        }
        let box_end = match offset.checked_add(size as usize) {
            Some(value) if value <= end => value,
            _ => break,
        };
        boxes.push(Mp4Box {
            kind,
            payload_start: offset + header,
            end: box_end,
        });
        if box_end <= offset {
            break;
        }
        offset = box_end;
    }

    boxes
}

fn child_box(bytes: &[u8], parent: Mp4Box, kind: &[u8; 4]) -> Option<Mp4Box> {
    mp4_boxes(bytes, parent.payload_start, parent.end)
        .into_iter()
        .find(|child| &child.kind == kind)
}

fn inspect_mp4(bytes: &[u8]) -> VideoInspection {
    let top = mp4_boxes(bytes, 0, bytes.len());
    let Some(moov) = top.iter().copied().find(|item| &item.kind == b"moov") else {
        return VideoInspection {
            container: "mp4".into(),
            duration_ms: None,
            tracks: Vec::new(),
            unsupported: Vec::new(),
            warnings: vec!["The MP4 has no readable movie metadata (moov box). Fragmented or incomplete files are not supported yet.".into()],
        };
    };

    let duration_ms = child_box(bytes, moov, b"mvhd").and_then(|mvhd| parse_mvhd_duration(bytes, mvhd));
    let mut tracks = Vec::new();
    let mut unsupported = Vec::new();
    let mut warnings = Vec::new();

    for trak in mp4_boxes(bytes, moov.payload_start, moov.end)
        .into_iter()
        .filter(|item| &item.kind == b"trak")
    {
        match parse_mp4_track(bytes, trak) {
            Ok(Some(Mp4TrackResult::Track(track))) => tracks.push(track),
            Ok(Some(Mp4TrackResult::Unsupported(track))) => unsupported.push(track),
            Ok(None) => {}
            Err(message) => warnings.push(message),
        }
    }

    VideoInspection {
        container: "mp4".into(),
        duration_ms,
        tracks,
        unsupported,
        warnings,
    }
}

fn parse_mvhd_duration(bytes: &[u8], mvhd: Mp4Box) -> Option<u64> {
    let version = *bytes.get(mvhd.payload_start)?;
    let (timescale_offset, duration_offset, duration_size) = if version == 1 {
        (mvhd.payload_start + 20, mvhd.payload_start + 24, 8)
    } else {
        (mvhd.payload_start + 12, mvhd.payload_start + 16, 4)
    };
    let timescale = be_u32(bytes, timescale_offset)? as u64;
    if timescale == 0 {
        return None;
    }
    let duration = if duration_size == 8 {
        be_u64(bytes, duration_offset)?
    } else {
        be_u32(bytes, duration_offset)? as u64
    };
    Some(duration.saturating_mul(1000) / timescale)
}

enum Mp4TrackResult {
    Track(SubtitleTrack),
    Unsupported(UnsupportedTrack),
}

#[derive(Default)]
struct Mp4SampleTable {
    codec: String,
    stts: Vec<(u32, u32)>,
    ctts: Vec<(u32, i64)>,
    stsc: Vec<(u32, u32)>,
    sizes: Vec<u32>,
    chunk_offsets: Vec<u64>,
}

fn parse_mp4_track(bytes: &[u8], trak: Mp4Box) -> Result<Option<Mp4TrackResult>, String> {
    let track_id = child_box(bytes, trak, b"tkhd")
        .and_then(|tkhd| parse_tkhd_id(bytes, tkhd))
        .unwrap_or(0);
    let Some(mdia) = child_box(bytes, trak, b"mdia") else {
        return Ok(None);
    };
    let (timescale, language) = child_box(bytes, mdia, b"mdhd")
        .and_then(|mdhd| parse_mdhd(bytes, mdhd))
        .unwrap_or((0, "und".into()));
    let (handler, handler_name) = child_box(bytes, mdia, b"hdlr")
        .and_then(|hdlr| parse_hdlr(bytes, hdlr))
        .unwrap_or_default();
    let Some(minf) = child_box(bytes, mdia, b"minf") else {
        return Ok(None);
    };
    let Some(stbl) = child_box(bytes, minf, b"stbl") else {
        return Ok(None);
    };
    let table = parse_mp4_sample_table(bytes, stbl);
    let textual_codec = matches!(table.codec.as_str(), "tx3g" | "wvtt" | "stpp" | "text");
    let subtitle_handler = matches!(handler.as_str(), "subt" | "sbtl" | "text" | "clcp");
    if !textual_codec && !subtitle_handler {
        return Ok(None);
    }

    let title = if handler_name.trim().is_empty() {
        if language != "und" {
            language.clone()
        } else {
            format!("Embedded subtitle {}", if track_id == 0 { "track".into() } else { track_id.to_string() })
        }
    } else {
        handler_name.trim_matches(char::from(0)).trim().to_string()
    };

    if !textual_codec {
        return Ok(Some(Mp4TrackResult::Unsupported(UnsupportedTrack {
            title,
            language,
            codec: if table.codec.is_empty() { "unknown".into() } else { table.codec },
            reason: "This embedded subtitle codec is not text-decodable in the static browser build.".into(),
        })));
    }
    if timescale == 0 {
        return Err(format!("Skipped MP4 subtitle track {track_id}: missing media timescale."));
    }

    let sample_offsets = build_mp4_sample_offsets(&table)
        .map_err(|message| format!("Skipped MP4 subtitle track {track_id}: {message}"))?;
    let timings = expand_mp4_timings(&table, sample_offsets.len());
    let mut cues = Vec::new();
    for (index, (offset, size)) in sample_offsets.into_iter().enumerate() {
        let start = usize::try_from(offset).ok();
        let size = size as usize;
        let Some(start) = start else { continue };
        let Some(end) = start.checked_add(size) else { continue };
        let Some(sample) = bytes.get(start..end) else { continue };
        let Some((start_units, duration_units)) = timings.get(index).copied() else { break };
        let start_ms = units_to_ms(start_units, timescale);
        let end_ms = units_to_ms(start_units.saturating_add(duration_units), timescale).max(start_ms);
        for text in decode_mp4_sample(&table.codec, sample) {
            if !text.trim().is_empty() {
                cues.push(Cue {
                    start_ms,
                    end_ms,
                    text: text.trim().to_string(),
                });
            }
        }
    }

    Ok(Some(Mp4TrackResult::Track(SubtitleTrack {
        id: format!("embedded-mp4-{track_id}"),
        title,
        language,
        format: match table.codec.as_str() {
            "wvtt" => "webvtt".into(),
            "stpp" => "ttml".into(),
            _ => "text".into(),
        },
        codec: table.codec,
        forced: false,
        cues,
    })))
}

fn parse_tkhd_id(bytes: &[u8], tkhd: Mp4Box) -> Option<u32> {
    let version = *bytes.get(tkhd.payload_start)?;
    let offset = if version == 1 { tkhd.payload_start + 20 } else { tkhd.payload_start + 12 };
    be_u32(bytes, offset)
}

fn parse_mdhd(bytes: &[u8], mdhd: Mp4Box) -> Option<(u64, String)> {
    let version = *bytes.get(mdhd.payload_start)?;
    let (timescale_offset, language_offset) = if version == 1 {
        (mdhd.payload_start + 20, mdhd.payload_start + 32)
    } else {
        (mdhd.payload_start + 12, mdhd.payload_start + 20)
    };
    let timescale = be_u32(bytes, timescale_offset)? as u64;
    let language = decode_mp4_language(be_u16(bytes, language_offset)?);
    Some((timescale, language))
}

fn decode_mp4_language(value: u16) -> String {
    if value == 0 {
        return "und".into();
    }
    let a = (((value >> 10) & 0x1f) as u8).saturating_add(0x60);
    let b = (((value >> 5) & 0x1f) as u8).saturating_add(0x60);
    let c = ((value & 0x1f) as u8).saturating_add(0x60);
    String::from_utf8_lossy(&[a, b, c]).into_owned()
}

fn parse_hdlr(bytes: &[u8], hdlr: Mp4Box) -> Option<(String, String)> {
    let handler = std::str::from_utf8(bytes.get(hdlr.payload_start + 8..hdlr.payload_start + 12)?)
        .ok()?
        .to_string();
    let name_start = hdlr.payload_start + 24;
    let name = if name_start < hdlr.end {
        decode_text(&bytes[name_start..hdlr.end]).trim_matches(char::from(0)).to_string()
    } else {
        String::new()
    };
    Some((handler, name))
}

fn parse_mp4_sample_table(bytes: &[u8], stbl: Mp4Box) -> Mp4SampleTable {
    let mut table = Mp4SampleTable::default();
    for item in mp4_boxes(bytes, stbl.payload_start, stbl.end) {
        match &item.kind {
            b"stsd" => table.codec = parse_stsd_codec(bytes, item).unwrap_or_default(),
            b"stts" => table.stts = parse_stts(bytes, item),
            b"ctts" => table.ctts = parse_ctts(bytes, item),
            b"stsc" => table.stsc = parse_stsc(bytes, item),
            b"stsz" => table.sizes = parse_stsz(bytes, item),
            b"stco" => table.chunk_offsets = parse_stco(bytes, item),
            b"co64" => table.chunk_offsets = parse_co64(bytes, item),
            _ => {}
        }
    }
    table
}

fn parse_stsd_codec(bytes: &[u8], stsd: Mp4Box) -> Option<String> {
    let count = be_u32(bytes, stsd.payload_start + 4)? as usize;
    if count == 0 {
        return None;
    }
    let entry = stsd.payload_start + 8;
    let _size = be_u32(bytes, entry)?;
    let codec = std::str::from_utf8(bytes.get(entry + 4..entry + 8)?).ok()?;
    Some(codec.to_string())
}

fn parse_stts(bytes: &[u8], stts: Mp4Box) -> Vec<(u32, u32)> {
    let count = be_u32(bytes, stts.payload_start + 4).unwrap_or(0) as usize;
    (0..count)
        .filter_map(|index| {
            let offset = stts.payload_start + 8 + index * 8;
            Some((be_u32(bytes, offset)?, be_u32(bytes, offset + 4)?))
        })
        .collect()
}

fn parse_ctts(bytes: &[u8], ctts: Mp4Box) -> Vec<(u32, i64)> {
    let version = *bytes.get(ctts.payload_start).unwrap_or(&0);
    let count = be_u32(bytes, ctts.payload_start + 4).unwrap_or(0) as usize;
    (0..count)
        .filter_map(|index| {
            let offset = ctts.payload_start + 8 + index * 8;
            let samples = be_u32(bytes, offset)?;
            let raw = be_u32(bytes, offset + 4)?;
            let composition = if version == 1 { (raw as i32) as i64 } else { raw as i64 };
            Some((samples, composition))
        })
        .collect()
}

fn parse_stsc(bytes: &[u8], stsc: Mp4Box) -> Vec<(u32, u32)> {
    let count = be_u32(bytes, stsc.payload_start + 4).unwrap_or(0) as usize;
    (0..count)
        .filter_map(|index| {
            let offset = stsc.payload_start + 8 + index * 12;
            Some((be_u32(bytes, offset)?, be_u32(bytes, offset + 4)?))
        })
        .collect()
}

fn parse_stsz(bytes: &[u8], stsz: Mp4Box) -> Vec<u32> {
    let sample_size = be_u32(bytes, stsz.payload_start + 4).unwrap_or(0);
    let count = be_u32(bytes, stsz.payload_start + 8).unwrap_or(0) as usize;
    if sample_size != 0 {
        return vec![sample_size; count];
    }
    (0..count)
        .filter_map(|index| be_u32(bytes, stsz.payload_start + 12 + index * 4))
        .collect()
}

fn parse_stco(bytes: &[u8], stco: Mp4Box) -> Vec<u64> {
    let count = be_u32(bytes, stco.payload_start + 4).unwrap_or(0) as usize;
    (0..count)
        .filter_map(|index| be_u32(bytes, stco.payload_start + 8 + index * 4).map(u64::from))
        .collect()
}

fn parse_co64(bytes: &[u8], co64: Mp4Box) -> Vec<u64> {
    let count = be_u32(bytes, co64.payload_start + 4).unwrap_or(0) as usize;
    (0..count)
        .filter_map(|index| be_u64(bytes, co64.payload_start + 8 + index * 8))
        .collect()
}

fn build_mp4_sample_offsets(table: &Mp4SampleTable) -> Result<Vec<(u64, u32)>, String> {
    if table.sizes.is_empty() {
        return Ok(Vec::new());
    }
    if table.chunk_offsets.is_empty() || table.stsc.is_empty() {
        return Err("sample chunk mapping is missing".into());
    }
    let mut result = Vec::with_capacity(table.sizes.len());
    let mut sample_index = 0_usize;

    for (chunk_zero_index, chunk_offset) in table.chunk_offsets.iter().copied().enumerate() {
        if sample_index >= table.sizes.len() {
            break;
        }
        let chunk_number = chunk_zero_index as u32 + 1;
        let samples_per_chunk = table
            .stsc
            .iter()
            .rev()
            .find(|(first_chunk, _)| *first_chunk <= chunk_number)
            .map(|(_, samples)| *samples)
            .ok_or_else(|| "sample-to-chunk table does not cover every chunk".to_string())?;
        let mut offset = chunk_offset;
        for _ in 0..samples_per_chunk {
            let Some(size) = table.sizes.get(sample_index).copied() else { break };
            result.push((offset, size));
            offset = offset.saturating_add(size as u64);
            sample_index += 1;
        }
    }

    if sample_index < table.sizes.len() {
        return Err("sample table references more samples than the chunk table contains".into());
    }
    Ok(result)
}

fn expand_mp4_timings(table: &Mp4SampleTable, count: usize) -> Vec<(u64, u64)> {
    let mut dts = Vec::with_capacity(count);
    let mut cursor = 0_u64;
    for (sample_count, delta) in &table.stts {
        for _ in 0..*sample_count {
            if dts.len() == count {
                break;
            }
            dts.push((cursor, *delta as u64));
            cursor = cursor.saturating_add(*delta as u64);
        }
    }
    while dts.len() < count {
        dts.push((cursor, 0));
    }

    if table.ctts.is_empty() {
        return dts;
    }
    let mut offsets = Vec::with_capacity(count);
    for (sample_count, offset) in &table.ctts {
        for _ in 0..*sample_count {
            if offsets.len() == count {
                break;
            }
            offsets.push(*offset);
        }
    }
    offsets.resize(count, 0);
    dts.into_iter()
        .enumerate()
        .map(|(index, (start, duration))| {
            let offset = offsets[index];
            let start = if offset < 0 {
                start.saturating_sub(offset.unsigned_abs())
            } else {
                start.saturating_add(offset as u64)
            };
            (start, duration)
        })
        .collect()
}

fn decode_mp4_sample(codec: &str, sample: &[u8]) -> Vec<String> {
    match codec {
        "tx3g" | "text" => {
            if sample.len() < 2 {
                return Vec::new();
            }
            let declared = u16::from_be_bytes([sample[0], sample[1]]) as usize;
            let end = (2 + declared).min(sample.len());
            vec![decode_text(&sample[2..end])]
        }
        "wvtt" => {
            let mut output = Vec::new();
            for vttc in mp4_boxes(sample, 0, sample.len()).into_iter().filter(|item| &item.kind == b"vttc") {
                let mut text = String::new();
                for child in mp4_boxes(sample, vttc.payload_start, vttc.end) {
                    if &child.kind == b"payl" {
                        text.push_str(&decode_text(&sample[child.payload_start..child.end]));
                    }
                }
                if !text.is_empty() {
                    output.push(text);
                }
            }
            output
        }
        "stpp" => {
            let text = decode_text(sample);
            let clean = strip_markup(&text);
            if clean.is_empty() { Vec::new() } else { vec![clean] }
        }
        _ => Vec::new(),
    }
}

fn units_to_ms(units: u64, timescale: u64) -> u64 {
    if timescale == 0 {
        0
    } else {
        units.saturating_mul(1000) / timescale
    }
}

#[derive(Debug, Clone, Copy)]
struct EbmlElement {
    id: u64,
    payload_start: usize,
    end: usize,
}

fn read_ebml_vint(bytes: &[u8], offset: usize, keep_marker: bool) -> Option<(u64, usize, bool)> {
    let first = *bytes.get(offset)?;
    if first == 0 {
        return None;
    }
    let width = first.leading_zeros() as usize + 1;
    if width > 8 || offset + width > bytes.len() {
        return None;
    }
    let marker = 1_u8 << (8 - width);
    let mut value = if keep_marker { first as u64 } else { (first & !marker) as u64 };
    for byte in &bytes[offset + 1..offset + width] {
        value = (value << 8) | *byte as u64;
    }
    let unknown = if keep_marker {
        false
    } else {
        let bits = 7 * width;
        value == ((1_u64 << bits) - 1)
    };
    Some((value, width, unknown))
}

fn ebml_elements(bytes: &[u8], start: usize, end: usize) -> Vec<EbmlElement> {
    let mut elements = Vec::new();
    let mut offset = start;
    let end = end.min(bytes.len());
    while offset < end {
        let Some((id, id_width, _)) = read_ebml_vint(bytes, offset, true) else { break };
        let size_offset = offset + id_width;
        let Some((size, size_width, unknown)) = read_ebml_vint(bytes, size_offset, false) else { break };
        let payload_start = size_offset + size_width;
        let element_end = if unknown {
            end
        } else {
            let Ok(size) = usize::try_from(size) else { break };
            match payload_start.checked_add(size) {
                Some(value) if value <= end => value,
                _ => break,
            }
        };
        elements.push(EbmlElement {
            id,
            payload_start,
            end: element_end,
        });
        if element_end <= offset {
            break;
        }
        offset = element_end;
    }
    elements
}

#[derive(Debug, Clone)]
struct MatroskaTrackMeta {
    title: String,
    language: String,
    codec: String,
    forced: bool,
}

fn inspect_matroska(bytes: &[u8]) -> VideoInspection {
    let top = ebml_elements(bytes, 0, bytes.len());
    let Some(segment) = top.into_iter().find(|element| element.id == 0x1853_8067) else {
        return VideoInspection {
            container: "matroska".into(),
            duration_ms: None,
            tracks: Vec::new(),
            unsupported: Vec::new(),
            warnings: vec!["The Matroska/WebM file has no readable Segment element.".into()],
        };
    };

    let children = ebml_elements(bytes, segment.payload_start, segment.end);
    let mut timestamp_scale = 1_000_000_u64;
    let mut duration_ticks: Option<f64> = None;
    let mut subtitle_meta: BTreeMap<u64, MatroskaTrackMeta> = BTreeMap::new();
    let mut clusters = Vec::new();
    let mut warnings = Vec::new();

    for child in &children {
        match child.id {
            0x1549_A966 => {
                for item in ebml_elements(bytes, child.payload_start, child.end) {
                    match item.id {
                        0x2A_D7_B1 => timestamp_scale = ebml_uint(bytes, item).unwrap_or(timestamp_scale),
                        0x4489 => duration_ticks = ebml_float(bytes, item),
                        _ => {}
                    }
                }
            }
            0x1654_AE6B => parse_matroska_tracks(bytes, *child, &mut subtitle_meta),
            0x1F43_B675 => clusters.push(*child),
            _ => {}
        }
    }

    let mut track_cues: BTreeMap<u64, Vec<Cue>> = subtitle_meta
        .keys()
        .copied()
        .map(|number| (number, Vec::new()))
        .collect();

    for cluster in clusters {
        parse_matroska_cluster(
            bytes,
            cluster,
            timestamp_scale,
            &subtitle_meta,
            &mut track_cues,
            &mut warnings,
        );
    }

    let mut tracks = Vec::new();
    let mut unsupported = Vec::new();
    for (number, meta) in subtitle_meta {
        if matroska_text_codec(&meta.codec) {
            let mut cues = track_cues.remove(&number).unwrap_or_default();
            finalize_open_cue_durations(&mut cues);
            tracks.push(SubtitleTrack {
                id: format!("embedded-matroska-{number}"),
                title: meta.title,
                language: meta.language,
                format: matroska_format(&meta.codec).into(),
                codec: meta.codec,
                forced: meta.forced,
                cues,
            });
        } else {
            unsupported.push(UnsupportedTrack {
                title: meta.title,
                language: meta.language,
                codec: meta.codec,
                reason: "Bitmap or otherwise non-text Matroska subtitles are reported but cannot be converted to editable text by this static build.".into(),
            });
        }
    }

    let duration_ms = duration_ticks.and_then(|duration| {
        if duration.is_finite() && duration >= 0.0 {
            Some((duration * timestamp_scale as f64 / 1_000_000.0).round() as u64)
        } else {
            None
        }
    });

    VideoInspection {
        container: "matroska".into(),
        duration_ms,
        tracks,
        unsupported,
        warnings,
    }
}

fn parse_matroska_tracks(
    bytes: &[u8],
    tracks: EbmlElement,
    output: &mut BTreeMap<u64, MatroskaTrackMeta>,
) {
    for entry in ebml_elements(bytes, tracks.payload_start, tracks.end)
        .into_iter()
        .filter(|item| item.id == 0xAE)
    {
        let mut number = 0_u64;
        let mut track_type = 0_u64;
        let mut title = String::new();
        let mut language = "und".to_string();
        let mut codec = String::new();
        let mut forced = false;
        for item in ebml_elements(bytes, entry.payload_start, entry.end) {
            match item.id {
                0xD7 => number = ebml_uint(bytes, item).unwrap_or(0),
                0x83 => track_type = ebml_uint(bytes, item).unwrap_or(0),
                0x536E => title = ebml_string(bytes, item),
                0x22B59C | 0x22B59D => {
                    let value = ebml_string(bytes, item);
                    if !value.is_empty() {
                        language = value;
                    }
                }
                0x86 => codec = ebml_string(bytes, item),
                0x55AA => forced = ebml_uint(bytes, item).unwrap_or(0) != 0,
                _ => {}
            }
        }
        if track_type == 0x11 && number != 0 {
            if title.is_empty() {
                title = if language == "und" {
                    format!("Embedded subtitle {number}")
                } else {
                    language.clone()
                };
            }
            output.insert(
                number,
                MatroskaTrackMeta {
                    title,
                    language,
                    codec,
                    forced,
                },
            );
        }
    }
}

fn parse_matroska_cluster(
    bytes: &[u8],
    cluster: EbmlElement,
    timestamp_scale: u64,
    tracks: &BTreeMap<u64, MatroskaTrackMeta>,
    output: &mut BTreeMap<u64, Vec<Cue>>,
    warnings: &mut Vec<String>,
) {
    let children = ebml_elements(bytes, cluster.payload_start, cluster.end);
    let cluster_time = children
        .iter()
        .copied()
        .find(|item| item.id == 0xE7)
        .and_then(|item| ebml_uint(bytes, item))
        .unwrap_or(0) as i64;

    for item in children {
        match item.id {
            0xA3 => parse_matroska_block(
                &bytes[item.payload_start..item.end],
                None,
                cluster_time,
                timestamp_scale,
                tracks,
                output,
                warnings,
            ),
            0xA0 => {
                let group_children = ebml_elements(bytes, item.payload_start, item.end);
                let duration = group_children
                    .iter()
                    .copied()
                    .find(|child| child.id == 0x9B)
                    .and_then(|child| ebml_uint(bytes, child));
                if let Some(block) = group_children.into_iter().find(|child| child.id == 0xA1) {
                    parse_matroska_block(
                        &bytes[block.payload_start..block.end],
                        duration,
                        cluster_time,
                        timestamp_scale,
                        tracks,
                        output,
                        warnings,
                    );
                }
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn parse_matroska_block(
    block: &[u8],
    duration_ticks: Option<u64>,
    cluster_time: i64,
    timestamp_scale: u64,
    tracks: &BTreeMap<u64, MatroskaTrackMeta>,
    output: &mut BTreeMap<u64, Vec<Cue>>,
    warnings: &mut Vec<String>,
) {
    let Some((track_number, width, _)) = read_ebml_vint(block, 0, false) else { return };
    if !tracks.contains_key(&track_number) || block.len() < width + 3 {
        return;
    }
    let relative = i16::from_be_bytes([block[width], block[width + 1]]) as i64;
    let flags = block[width + 2];
    if flags & 0x06 != 0 {
        warnings.push(format!("Skipped a laced subtitle block on Matroska track {track_number}."));
        return;
    }
    let payload = &block[width + 3..];
    let meta = &tracks[&track_number];
    if !matroska_text_codec(&meta.codec) {
        return;
    }
    let text = decode_matroska_subtitle(&meta.codec, payload);
    if text.trim().is_empty() {
        return;
    }
    let start_ticks = cluster_time.saturating_add(relative).max(0) as u64;
    let start_ms = start_ticks.saturating_mul(timestamp_scale) / 1_000_000;
    let end_ms = duration_ticks
        .map(|duration| {
            start_ms.saturating_add(duration.saturating_mul(timestamp_scale) / 1_000_000)
        })
        .unwrap_or(start_ms);
    output.entry(track_number).or_default().push(Cue {
        start_ms,
        end_ms,
        text: text.trim().to_string(),
    });
}

fn matroska_text_codec(codec: &str) -> bool {
    matches!(
        codec,
        "S_TEXT/UTF8"
            | "S_TEXT/ASCII"
            | "S_TEXT/ASS"
            | "S_TEXT/SSA"
            | "S_TEXT/WEBVTT"
            | "S_TEXT/USF"
    )
}

fn matroska_format(codec: &str) -> &'static str {
    match codec {
        "S_TEXT/ASS" => "ass",
        "S_TEXT/SSA" => "ssa",
        "S_TEXT/WEBVTT" => "webvtt",
        "S_TEXT/USF" => "usf",
        _ => "text",
    }
}

fn decode_matroska_subtitle(codec: &str, payload: &[u8]) -> String {
    let text = decode_text(payload);
    match codec {
        "S_TEXT/ASS" | "S_TEXT/SSA" => {
            let dialogue = text.splitn(9, ',').nth(8).unwrap_or(&text);
            clean_ass_text(dialogue)
        }
        "S_TEXT/USF" => strip_markup(&text),
        _ => text,
    }
}

fn finalize_open_cue_durations(cues: &mut [Cue]) {
    cues.sort_by_key(|cue| cue.start_ms);
    for index in 0..cues.len() {
        if cues[index].end_ms > cues[index].start_ms {
            continue;
        }
        let next = cues.get(index + 1).map(|cue| cue.start_ms);
        cues[index].end_ms = next
            .filter(|next_start| *next_start > cues[index].start_ms)
            .unwrap_or_else(|| cues[index].start_ms.saturating_add(2000));
    }
}

fn ebml_uint(bytes: &[u8], element: EbmlElement) -> Option<u64> {
    let data = bytes.get(element.payload_start..element.end)?;
    if data.is_empty() || data.len() > 8 {
        return None;
    }
    Some(data.iter().fold(0_u64, |value, byte| (value << 8) | *byte as u64))
}

fn ebml_float(bytes: &[u8], element: EbmlElement) -> Option<f64> {
    let data = bytes.get(element.payload_start..element.end)?;
    match data.len() {
        4 => Some(f32::from_bits(u32::from_be_bytes(data.try_into().ok()?)) as f64),
        8 => Some(f64::from_bits(u64::from_be_bytes(data.try_into().ok()?))),
        _ => None,
    }
}

fn ebml_string(bytes: &[u8], element: EbmlElement) -> String {
    decode_text(bytes.get(element.payload_start..element.end).unwrap_or(&[]))
        .trim_matches(char::from(0))
        .to_string()
}

fn strip_markup(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !output.ends_with(' ') && !output.ends_with('\n') {
                    output.push(' ');
                }
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?))
}

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?))
}

fn be_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(offset..offset + 8)?.try_into().ok()?))
}

fn video_inspection_json(value: &VideoInspection) -> String {
    let mut json = String::from("{");
    json.push_str("\"container\":");
    push_json_string(&mut json, &value.container);
    json.push_str(",\"durationMs\":");
    match value.duration_ms {
        Some(duration) => json.push_str(&duration.to_string()),
        None => json.push_str("null"),
    }
    json.push_str(",\"tracks\":[");
    for (index, track) in value.tracks.iter().enumerate() {
        if index > 0 { json.push(','); }
        push_track_json(&mut json, track);
    }
    json.push_str("],\"unsupported\":[");
    for (index, track) in value.unsupported.iter().enumerate() {
        if index > 0 { json.push(','); }
        json.push('{');
        push_json_field(&mut json, "title", &track.title, false);
        push_json_field(&mut json, "language", &track.language, true);
        push_json_field(&mut json, "codec", &track.codec, true);
        push_json_field(&mut json, "reason", &track.reason, true);
        json.push('}');
    }
    json.push_str("],\"warnings\":");
    push_string_array(&mut json, &value.warnings);
    json.push('}');
    json
}

fn parsed_subtitle_json(value: &ParsedSubtitle) -> String {
    let mut json = String::from("{");
    push_json_field(&mut json, "format", &value.format, false);
    json.push_str(",\"cues\":[");
    for (index, cue) in value.cues.iter().enumerate() {
        if index > 0 { json.push(','); }
        push_cue_json(&mut json, cue);
    }
    json.push_str("],\"warnings\":");
    push_string_array(&mut json, &value.warnings);
    json.push('}');
    json
}

fn push_track_json(json: &mut String, track: &SubtitleTrack) {
    json.push('{');
    push_json_field(json, "id", &track.id, false);
    push_json_field(json, "title", &track.title, true);
    push_json_field(json, "language", &track.language, true);
    push_json_field(json, "format", &track.format, true);
    push_json_field(json, "codec", &track.codec, true);
    json.push_str(",\"origin\":\"embedded\"");
    json.push_str(",\"forced\":");
    json.push_str(if track.forced { "true" } else { "false" });
    json.push_str(",\"cues\":[");
    for (index, cue) in track.cues.iter().enumerate() {
        if index > 0 { json.push(','); }
        push_cue_json(json, cue);
    }
    json.push_str("]}");
}

fn push_cue_json(json: &mut String, cue: &Cue) {
    json.push_str("{\"startMs\":");
    json.push_str(&cue.start_ms.to_string());
    json.push_str(",\"endMs\":");
    json.push_str(&cue.end_ms.to_string());
    json.push_str(",\"text\":");
    push_json_string(json, &cue.text);
    json.push('}');
}

fn push_json_field(json: &mut String, key: &str, value: &str, leading_comma: bool) {
    if leading_comma { json.push(','); }
    push_json_string(json, key);
    json.push(':');
    push_json_string(json, value);
}

fn push_string_array(json: &mut String, values: &[String]) {
    json.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 { json.push(','); }
        push_json_string(json, value);
    }
    json.push(']');
}

fn push_json_string(json: &mut String, value: &str) {
    json.push('"');
    for ch in value.chars() {
        match ch {
            '"' => json.push_str("\\\""),
            '\\' => json.push_str("\\\\"),
            '\n' => json.push_str("\\n"),
            '\r' => json.push_str("\\r"),
            '\t' => json.push_str("\\t"),
            ch if ch < ' ' => json.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => json.push(ch),
        }
    }
    json.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_cues() {
        let parsed = parse_subtitle_bytes(
            b"1\n00:00:01,250 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:05,000\nSecond cue\n",
        );
        assert_eq!(parsed.format, "srt");
        assert_eq!(parsed.cues.len(), 2);
        assert_eq!(parsed.cues[0].start_ms, 1250);
        assert_eq!(parsed.cues[0].end_ms, 3500);
        assert_eq!(parsed.cues[1].text, "Second cue");
    }

    #[test]
    fn parses_webvtt_settings_without_polluting_timestamp() {
        let parsed = parse_subtitle_bytes(
            b"WEBVTT\n\nvoice-1\n00:01.000 --> 00:02.250 align:start position:10%\nHello\n",
        );
        assert_eq!(parsed.format, "webvtt");
        assert_eq!(parsed.cues[0].start_ms, 1000);
        assert_eq!(parsed.cues[0].end_ms, 2250);
        assert_eq!(parsed.cues[0].text, "Hello");
    }

    #[test]
    fn parses_ass_and_removes_override_tags() {
        let parsed = parse_subtitle_bytes(
            b"[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:02.30,Default,,0,0,0,,{\\i1}Hello\\Nworld\n",
        );
        assert_eq!(parsed.format, "ass");
        assert_eq!(parsed.cues[0].start_ms, 1200);
        assert_eq!(parsed.cues[0].end_ms, 2300);
        assert_eq!(parsed.cues[0].text, "Hello\nworld");
    }

    #[test]
    fn decodes_tx3g_payload() {
        let sample = [0_u8, 5, b'H', b'e', b'l', b'l', b'o', 0, 0];
        assert_eq!(decode_mp4_sample("tx3g", &sample), vec!["Hello"]);
    }

    #[test]
    fn decodes_wvtt_payload_box() {
        let mut sample = Vec::new();
        sample.extend_from_slice(&17_u32.to_be_bytes());
        sample.extend_from_slice(b"vttc");
        sample.extend_from_slice(&9_u32.to_be_bytes());
        sample.extend_from_slice(b"payl");
        sample.push(b'A');
        assert_eq!(decode_mp4_sample("wvtt", &sample), vec!["A"]);
    }

    #[test]
    fn reads_ebml_variable_integer() {
        assert_eq!(read_ebml_vint(&[0x81], 0, false), Some((1, 1, false)));
        assert_eq!(read_ebml_vint(&[0x40, 0x7f], 0, false), Some((127, 2, false)));
        assert_eq!(read_ebml_vint(&[0x1a, 0x45, 0xdf, 0xa3], 0, true), Some((0x1a45dfa3, 4, false)));
    }

    #[test]
    fn finalizes_matroska_cue_without_duration_from_next_start() {
        let mut cues = vec![
            Cue { start_ms: 1000, end_ms: 1000, text: "a".into() },
            Cue { start_ms: 2400, end_ms: 3000, text: "b".into() },
        ];
        finalize_open_cue_durations(&mut cues);
        assert_eq!(cues[0].end_ms, 2400);
        assert_eq!(cues[1].end_ms, 3000);
    }

    #[test]
    fn emits_valid_json_escaping() {
        let parsed = ParsedSubtitle {
            format: "srt".into(),
            cues: vec![Cue { start_ms: 0, end_ms: 1, text: "quote \" and newline\n".into() }],
            warnings: Vec::new(),
        };
        let json = parsed_subtitle_json(&parsed);
        assert!(json.contains("quote \\\" and newline\\n"));
    }
}
