use std::collections::VecDeque;

use super::{
    be_u16, be_u32, build_mp4_sample_offsets, child_box, ebml_elements, ebml_float, ebml_uint,
    expand_mp4_timings, mp4_boxes, parse_hdlr, parse_mdhd, parse_mp4_sample_table, push_json_string,
    read_ebml_vint, return_json, EbmlElement, Mp4Box,
};

const HEADER_READ_BYTES: u32 = 32;
const MAX_METADATA_BYTES: u64 = 64 * 1024 * 1024;
const MAX_AUDIO_BATCH_BYTES: u64 = 1024 * 1024;
const MAX_AUDIO_SAMPLE_GAP_BYTES: u64 = 16 * 1024;
const MAX_MATROSKA_AUDIO_BLOCK_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
struct AudioDecoderConfig {
    codec: String,
    sample_rate: u32,
    channels: u32,
    description: Vec<u8>,
}

#[derive(Debug, Clone)]
struct AudioChunk {
    offset: u64,
    length: u32,
    timestamp_us: u64,
    duration_us: Option<u64>,
}

#[derive(Debug, Clone)]
struct AudioBatch {
    offset: u64,
    length: u32,
    chunks: Vec<AudioChunk>,
}

#[derive(Debug, Clone)]
struct ReadRequest {
    offset: u64,
    length: u32,
    phase: &'static str,
    purpose: ReadPurpose,
}

#[derive(Debug, Clone)]
enum ReadPurpose {
    Detect,
    Mp4TopHeader,
    Mp4Moov,
    MatroskaHeader,
    MatroskaInfo { scope_depth: usize },
    MatroskaTracks { scope_depth: usize },
    MatroskaClusterTime { scope_depth: usize },
    MatroskaBlockPrefix {
        payload_offset: u64,
        payload_length: u64,
        cluster_time: i64,
    },
    MatroskaBlockPayload {
        payload_offset: u64,
        cluster_time: i64,
    },
}

#[derive(Debug)]
struct AudioDemux {
    file_len: u64,
    state: DemuxState,
    pending_read: Option<ReadRequest>,
    pending_config: Option<AudioDecoderConfig>,
    config_delivered: bool,
    pending_batch: Option<AudioBatch>,
    done: bool,
    error: Option<String>,
}

#[derive(Debug)]
enum DemuxState {
    Detect,
    Mp4(Mp4AudioState),
    Matroska(MatroskaAudioState),
}

#[derive(Debug)]
struct Mp4AudioState {
    scan_offset: u64,
    metadata_ready: bool,
    batches: VecDeque<AudioBatch>,
}

#[derive(Debug)]
struct MatroskaAudioState {
    scopes: Vec<MatroskaScope>,
    segment_seen: bool,
    timestamp_scale: u64,
    audio_track: Option<MatroskaAudioTrack>,
}

#[derive(Debug, Clone)]
struct MatroskaAudioTrack {
    number: u64,
    codec: String,
    sample_rate: u32,
    channels: u32,
}

#[derive(Debug)]
struct MatroskaScope {
    offset: u64,
    end: u64,
    kind: MatroskaScopeKind,
}

#[derive(Debug)]
enum MatroskaScopeKind {
    Top,
    Segment,
    Cluster { time: i64 },
    BlockGroup { cluster_time: i64 },
}

#[derive(Debug, Clone, Copy)]
struct Mp4Header {
    kind: [u8; 4],
    end: u64,
}

#[derive(Debug, Clone, Copy)]
struct EbmlHeader {
    id: u64,
    payload_offset: u64,
    payload_length: u64,
    end: u64,
}

impl AudioDemux {
    fn new(file_len: u64) -> Self {
        let mut value = Self {
            file_len,
            state: DemuxState::Detect,
            pending_read: None,
            pending_config: None,
            config_delivered: false,
            pending_batch: None,
            done: false,
            error: None,
        };
        if file_len == 0 {
            value.fail("The selected Reference Video is empty.");
        } else {
            value.pending_read = Some(ReadRequest {
                offset: 0,
                length: read_length(file_len, 0, HEADER_READ_BYTES as u64),
                phase: "Detecting audio container",
                purpose: ReadPurpose::Detect,
            });
        }
        value
    }

    fn poll_json(&mut self) -> String {
        if self.error.is_none()
            && !self.done
            && self.pending_read.is_none()
            && self.pending_config.is_none()
            && self.pending_batch.is_none()
        {
            self.advance();
        }

        if let Some(message) = &self.error {
            let mut json = String::from("{\"status\":\"error\",\"message\":");
            push_json_string(&mut json, message);
            json.push('}');
            return json;
        }
        if let Some(config) = &self.pending_config {
            let mut json = format!(
                "{{\"status\":\"config\",\"codec\":",
            );
            push_json_string(&mut json, &config.codec);
            json.push_str(&format!(
                ",\"sampleRate\":{},\"numberOfChannels\":{},\"descriptionHex\":",
                config.sample_rate, config.channels
            ));
            push_json_string(&mut json, &hex_bytes(&config.description));
            json.push('}');
            return json;
        }
        if let Some(batch) = &self.pending_batch {
            let mut json = format!(
                "{{\"status\":\"batch\",\"offset\":{},\"length\":{},\"chunks\":[",
                batch.offset, batch.length
            );
            for (index, chunk) in batch.chunks.iter().enumerate() {
                if index > 0 {
                    json.push(',');
                }
                json.push_str(&format!(
                    "{{\"offset\":{},\"length\":{},\"timestampUs\":{}",
                    chunk.offset, chunk.length, chunk.timestamp_us
                ));
                if let Some(duration) = chunk.duration_us {
                    json.push_str(&format!(",\"durationUs\":{duration}"));
                }
                json.push('}');
            }
            json.push_str("]}");
            return json;
        }
        if let Some(request) = &self.pending_read {
            let mut json = format!(
                "{{\"status\":\"read\",\"offset\":{},\"length\":{},\"phase\":",
                request.offset, request.length
            );
            push_json_string(&mut json, request.phase);
            json.push('}');
            return json;
        }
        if self.done {
            return "{\"status\":\"done\"}".into();
        }
        "{\"status\":\"error\",\"message\":\"Audio demux stalled.\"}".into()
    }

    fn acknowledge(&mut self) -> bool {
        if self.pending_config.take().is_some() {
            self.config_delivered = true;
            self.advance();
            return true;
        }
        if self.pending_batch.take().is_some() {
            self.advance();
            return true;
        }
        false
    }

    fn supply(&mut self, offset: u64, bytes: &[u8]) {
        if self.error.is_some() || self.done {
            return;
        }
        let Some(request) = self.pending_read.take() else {
            self.fail("Rust did not request this audio range.");
            return;
        };
        if offset != request.offset || bytes.len() != request.length as usize {
            self.fail(&format!(
                "Audio range mismatch: requested {}..{}, received {} bytes at {}.",
                request.offset,
                request.offset.saturating_add(request.length as u64),
                bytes.len(),
                offset
            ));
            return;
        }

        let outcome = match request.purpose {
            ReadPurpose::Detect => self.consume_detect(bytes),
            ReadPurpose::Mp4TopHeader => self.consume_mp4_header(offset, bytes),
            ReadPurpose::Mp4Moov => self.consume_mp4_moov(bytes),
            ReadPurpose::MatroskaHeader => self.consume_matroska_header(offset, bytes),
            ReadPurpose::MatroskaInfo { scope_depth } => {
                self.consume_matroska_info(scope_depth, bytes)
            }
            ReadPurpose::MatroskaTracks { scope_depth } => {
                self.consume_matroska_tracks(scope_depth, bytes)
            }
            ReadPurpose::MatroskaClusterTime { scope_depth } => {
                self.consume_matroska_cluster_time(scope_depth, bytes)
            }
            ReadPurpose::MatroskaBlockPrefix {
                payload_offset,
                payload_length,
                cluster_time,
            } => self.consume_matroska_block_prefix(
                payload_offset,
                payload_length,
                cluster_time,
                bytes,
            ),
            ReadPurpose::MatroskaBlockPayload {
                payload_offset,
                cluster_time,
            } => self.consume_matroska_block(payload_offset, cluster_time, bytes),
        };
        if let Err(message) = outcome {
            self.fail(&message);
            return;
        }
        self.advance();
    }

    fn consume_detect(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() >= 8 && (&bytes[4..8] == b"ftyp" || &bytes[4..8] == b"moov") {
            self.state = DemuxState::Mp4(Mp4AudioState {
                scan_offset: 0,
                metadata_ready: false,
                batches: VecDeque::new(),
            });
            return Ok(());
        }
        if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
            self.state = DemuxState::Matroska(MatroskaAudioState {
                scopes: vec![MatroskaScope {
                    offset: 0,
                    end: self.file_len,
                    kind: MatroskaScopeKind::Top,
                }],
                segment_seen: false,
                timestamp_scale: 1_000_000,
                audio_track: None,
            });
            return Ok(());
        }
        Err(
            "Browser transcription currently supports audio demux from MP4/MOV and Matroska/WebM."
                .into(),
        )
    }

    fn advance(&mut self) {
        if self.error.is_some()
            || self.done
            || self.pending_read.is_some()
            || self.pending_config.is_some()
            || self.pending_batch.is_some()
        {
            return;
        }

        match &mut self.state {
            DemuxState::Detect => {}
            DemuxState::Mp4(state) => {
                if state.metadata_ready {
                    if let Some(batch) = state.batches.pop_front() {
                        self.pending_batch = Some(batch);
                    } else {
                        self.done = true;
                    }
                    return;
                }
                if state.scan_offset >= self.file_len {
                    self.fail("The MP4/MOV file has no readable movie metadata (moov box).");
                    return;
                }
                self.pending_read = Some(ReadRequest {
                    offset: state.scan_offset,
                    length: read_length(
                        self.file_len,
                        state.scan_offset,
                        HEADER_READ_BYTES as u64,
                    ),
                    phase: "Locating MP4 audio metadata",
                    purpose: ReadPurpose::Mp4TopHeader,
                });
            }
            DemuxState::Matroska(_) => self.advance_matroska(),
        }
    }

    fn consume_mp4_header(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let header = parse_mp4_header(bytes, offset, self.file_len)?;
        let DemuxState::Mp4(state) = &mut self.state else {
            return Err("MP4 audio state was lost.".into());
        };
        state.scan_offset = header.end;
        if &header.kind != b"moov" {
            return Ok(());
        }
        let total = header.end.saturating_sub(offset);
        ensure_metadata_size(total, "MP4 movie metadata")?;
        self.pending_read = Some(ReadRequest {
            offset,
            length: checked_read_length(total)?,
            phase: "Reading MP4 audio metadata",
            purpose: ReadPurpose::Mp4Moov,
        });
        Ok(())
    }

    fn consume_mp4_moov(&mut self, bytes: &[u8]) -> Result<(), String> {
        let top = mp4_boxes(bytes, 0, bytes.len());
        let moov = top
            .iter()
            .copied()
            .find(|item| &item.kind == b"moov")
            .ok_or_else(|| {
                "The requested MP4 metadata range did not contain a complete moov box.".to_string()
            })?;

        let mut plan = None;
        for trak in mp4_boxes(bytes, moov.payload_start, moov.end)
            .into_iter()
            .filter(|item| &item.kind == b"trak")
        {
            if let Some(candidate) = plan_mp4_audio_track(bytes, trak)? {
                plan = Some(candidate);
                break;
            }
        }
        let plan = plan.ok_or_else(|| {
            "The MP4/MOV file has no supported AAC audio track for browser transcription."
                .to_string()
        })?;

        self.pending_config = Some(plan.config);
        let DemuxState::Mp4(state) = &mut self.state else {
            return Err("MP4 audio state was lost after reading metadata.".into());
        };
        state.batches = plan.batches;
        state.metadata_ready = true;
        Ok(())
    }

    fn advance_matroska(&mut self) {
        loop {
            let DemuxState::Matroska(state) = &mut self.state else {
                return;
            };
            let Some(last_index) = state.scopes.len().checked_sub(1) else {
                if !state.segment_seen {
                    self.fail("The Matroska/WebM file has no readable Segment element.");
                } else if state.audio_track.is_none() {
                    self.fail(
                        "The Matroska/WebM file has no supported Opus audio track for browser transcription.",
                    );
                } else {
                    self.done = true;
                }
                return;
            };
            if state.scopes[last_index].offset >= state.scopes[last_index].end {
                state.scopes.pop();
                continue;
            }
            let offset = state.scopes[last_index].offset;
            let end = state.scopes[last_index].end;
            self.pending_read = Some(ReadRequest {
                offset,
                length: read_length(end, offset, HEADER_READ_BYTES as u64),
                phase: "Scanning Matroska audio structure",
                purpose: ReadPurpose::MatroskaHeader,
            });
            return;
        }
    }

    fn consume_matroska_header(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let DemuxState::Matroska(state) = &mut self.state else {
            return Err("Matroska audio state was lost.".into());
        };
        let scope_depth = state
            .scopes
            .len()
            .checked_sub(1)
            .ok_or_else(|| "Matroska scope stack is empty.".to_string())?;
        let scope_end = state.scopes[scope_depth].end;
        let header = parse_ebml_header(bytes, offset, scope_end)?;
        state.scopes[scope_depth].offset = header.end;

        match &state.scopes[scope_depth].kind {
            MatroskaScopeKind::Top => {
                if header.id == 0x1853_8067 {
                    state.segment_seen = true;
                    state.scopes.push(MatroskaScope {
                        offset: header.payload_offset,
                        end: header.end,
                        kind: MatroskaScopeKind::Segment,
                    });
                }
            }
            MatroskaScopeKind::Segment => match header.id {
                0x1549_A966 => {
                    ensure_metadata_size(header.payload_length, "Matroska Info")?;
                    self.pending_read = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading Matroska timing metadata",
                        purpose: ReadPurpose::MatroskaInfo { scope_depth },
                    });
                }
                0x1654_AE6B => {
                    ensure_metadata_size(header.payload_length, "Matroska Tracks")?;
                    self.pending_read = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading Matroska audio track metadata",
                        purpose: ReadPurpose::MatroskaTracks { scope_depth },
                    });
                }
                0x1F43_B675 => {
                    state.scopes.push(MatroskaScope {
                        offset: header.payload_offset,
                        end: header.end,
                        kind: MatroskaScopeKind::Cluster { time: 0 },
                    });
                }
                _ => {}
            },
            MatroskaScopeKind::Cluster { time } => match header.id {
                0xE7 => {
                    self.pending_read = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading Matroska cluster timing",
                        purpose: ReadPurpose::MatroskaClusterTime { scope_depth },
                    });
                }
                0xA3 => {
                    self.request_matroska_block(header, *time)?;
                }
                0xA0 => {
                    state.scopes.push(MatroskaScope {
                        offset: header.payload_offset,
                        end: header.end,
                        kind: MatroskaScopeKind::BlockGroup {
                            cluster_time: *time,
                        },
                    });
                }
                _ => {}
            },
            MatroskaScopeKind::BlockGroup { cluster_time } => {
                if header.id == 0xA1 {
                    self.request_matroska_block(header, *cluster_time)?;
                }
            }
        }
        Ok(())
    }

    fn request_matroska_block(
        &mut self,
        header: EbmlHeader,
        cluster_time: i64,
    ) -> Result<(), String> {
        if header.payload_length == 0 {
            return Ok(());
        }
        let prefix = header.payload_length.min(HEADER_READ_BYTES as u64);
        self.pending_read = Some(ReadRequest {
            offset: header.payload_offset,
            length: checked_read_length(prefix)?,
            phase: "Identifying Matroska audio block",
            purpose: ReadPurpose::MatroskaBlockPrefix {
                payload_offset: header.payload_offset,
                payload_length: header.payload_length,
                cluster_time,
            },
        });
        Ok(())
    }

    fn consume_matroska_info(
        &mut self,
        _scope_depth: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        let DemuxState::Matroska(state) = &mut self.state else {
            return Err("Matroska audio state was lost while reading Info.".into());
        };
        let element = EbmlElement {
            id: 0x1549_A966,
            payload_start: 0,
            end: bytes.len(),
        };
        for item in ebml_elements(bytes, element.payload_start, element.end) {
            if item.id == 0x2A_D7_B1 {
                state.timestamp_scale = ebml_uint(bytes, item).unwrap_or(state.timestamp_scale);
            }
        }
        Ok(())
    }

    fn consume_matroska_tracks(
        &mut self,
        _scope_depth: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        let track = parse_matroska_audio_track(bytes).ok_or_else(|| {
            "The Matroska/WebM file has no supported Opus audio track for browser transcription."
                .to_string()
        })?;
        self.pending_config = Some(AudioDecoderConfig {
            codec: "opus".into(),
            sample_rate: track.sample_rate,
            channels: track.channels,
            description: Vec::new(),
        });
        let DemuxState::Matroska(state) = &mut self.state else {
            return Err("Matroska audio state was lost while reading Tracks.".into());
        };
        state.audio_track = Some(track);
        Ok(())
    }

    fn consume_matroska_cluster_time(
        &mut self,
        scope_depth: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > 8 {
            return Err("Matroska cluster time had an invalid byte width.".into());
        }
        let value = bytes
            .iter()
            .fold(0_u64, |current, byte| (current << 8) | *byte as u64);
        let DemuxState::Matroska(state) = &mut self.state else {
            return Err("Matroska audio state was lost while reading cluster time.".into());
        };
        let Some(scope) = state.scopes.get_mut(scope_depth) else {
            return Err("Matroska cluster scope disappeared.".into());
        };
        if let MatroskaScopeKind::Cluster { time } = &mut scope.kind {
            *time = value.min(i64::MAX as u64) as i64;
        }
        Ok(())
    }

    fn consume_matroska_block_prefix(
        &mut self,
        payload_offset: u64,
        payload_length: u64,
        cluster_time: i64,
        bytes: &[u8],
    ) -> Result<(), String> {
        let Some((track_number, _, _)) = read_ebml_vint(bytes, 0, false) else {
            return Ok(());
        };
        let DemuxState::Matroska(state) = &self.state else {
            return Err("Matroska audio state was lost while identifying a block.".into());
        };
        let Some(track) = &state.audio_track else {
            return Ok(());
        };
        if track_number != track.number {
            return Ok(());
        }
        if payload_length > MAX_MATROSKA_AUDIO_BLOCK_BYTES {
            return Err(format!(
                "Matroska audio block is {} bytes, above the {} byte browser demux limit.",
                payload_length, MAX_MATROSKA_AUDIO_BLOCK_BYTES
            ));
        }
        if payload_length as usize <= bytes.len() {
            return self.consume_matroska_block(payload_offset, cluster_time, bytes);
        }
        self.pending_read = Some(ReadRequest {
            offset: payload_offset,
            length: checked_read_length(payload_length)?,
            phase: "Reading Matroska audio block",
            purpose: ReadPurpose::MatroskaBlockPayload {
                payload_offset,
                cluster_time,
            },
        });
        Ok(())
    }

    fn consume_matroska_block(
        &mut self,
        payload_offset: u64,
        cluster_time: i64,
        block: &[u8],
    ) -> Result<(), String> {
        let DemuxState::Matroska(state) = &self.state else {
            return Err("Matroska audio state was lost while decoding a block.".into());
        };
        let Some(track) = &state.audio_track else {
            return Ok(());
        };
        let Some((track_number, width, _)) = read_ebml_vint(block, 0, false) else {
            return Ok(());
        };
        if track_number != track.number || block.len() < width + 3 {
            return Ok(());
        }
        let relative = i16::from_be_bytes([block[width], block[width + 1]]) as i64;
        let flags = block[width + 2];
        let data_start = width + 3;
        let packet_ranges = parse_laced_packet_ranges(block, data_start, flags)?;
        if packet_ranges.is_empty() {
            return Ok(());
        }

        let start_ticks = cluster_time.saturating_add(relative).max(0) as u64;
        let mut timestamp_us = start_ticks.saturating_mul(state.timestamp_scale) / 1_000;
        let mut chunks = Vec::with_capacity(packet_ranges.len());
        for (start, end) in packet_ranges {
            let packet = &block[start..end];
            let duration_us = opus_packet_duration_us(packet);
            chunks.push(AudioChunk {
                offset: payload_offset.saturating_add(start as u64),
                length: (end - start) as u32,
                timestamp_us,
                duration_us,
            });
            timestamp_us = timestamp_us.saturating_add(duration_us.unwrap_or(0));
        }

        self.pending_batch = Some(AudioBatch {
            offset: payload_offset,
            length: block.len() as u32,
            chunks,
        });
        Ok(())
    }

    fn fail(&mut self, message: &str) {
        self.pending_read = None;
        self.pending_config = None;
        self.pending_batch = None;
        self.error = Some(message.to_string());
    }
}

struct Mp4AudioPlan {
    config: AudioDecoderConfig,
    batches: VecDeque<AudioBatch>,
}

fn plan_mp4_audio_track(bytes: &[u8], trak: Mp4Box) -> Result<Option<Mp4AudioPlan>, String> {
    let Some(mdia) = child_box(bytes, trak, b"mdia") else {
        return Ok(None);
    };
    let (handler, _) = child_box(bytes, mdia, b"hdlr")
        .and_then(|hdlr| parse_hdlr(bytes, hdlr))
        .unwrap_or_default();
    if handler != "soun" {
        return Ok(None);
    }
    let (timescale, _) = child_box(bytes, mdia, b"mdhd")
        .and_then(|mdhd| parse_mdhd(bytes, mdhd))
        .unwrap_or((0, "und".into()));
    if timescale == 0 {
        return Err("MP4 audio track is missing its media timescale.".into());
    }
    let Some(minf) = child_box(bytes, mdia, b"minf") else {
        return Ok(None);
    };
    let Some(stbl) = child_box(bytes, minf, b"stbl") else {
        return Ok(None);
    };
    let table = parse_mp4_sample_table(bytes, stbl);
    if table.codec != "mp4a" {
        return Ok(None);
    }
    let stsd = mp4_boxes(bytes, stbl.payload_start, stbl.end)
        .into_iter()
        .find(|item| &item.kind == b"stsd")
        .ok_or_else(|| "MP4 AAC track has no sample description.".to_string())?;
    let config = parse_mp4_aac_config(bytes, stsd)?;

    let offsets = build_mp4_sample_offsets(&table)
        .map_err(|message| format!("MP4 AAC sample mapping failed: {message}"))?;
    let timings = expand_mp4_timings(&table, offsets.len());
    let mut chunks = Vec::with_capacity(offsets.len());
    for (index, (offset, size)) in offsets.into_iter().enumerate() {
        let Some((start_units, duration_units)) = timings.get(index).copied() else {
            break;
        };
        chunks.push(AudioChunk {
            offset,
            length: size,
            timestamp_us: units_to_us(start_units, timescale),
            duration_us: Some(units_to_us(duration_units, timescale)),
        });
    }
    if chunks.is_empty() {
        return Err("MP4 AAC track contains no decodable audio samples.".into());
    }
    Ok(Some(Mp4AudioPlan {
        config,
        batches: build_audio_batches(chunks)?,
    }))
}

fn parse_mp4_aac_config(bytes: &[u8], stsd: Mp4Box) -> Result<AudioDecoderConfig, String> {
    let count = be_u32(bytes, stsd.payload_start + 4).unwrap_or(0);
    if count == 0 {
        return Err("MP4 audio sample description is empty.".into());
    }
    let entry = stsd.payload_start + 8;
    let size = be_u32(bytes, entry)
        .ok_or_else(|| "MP4 audio sample entry is truncated.".to_string())? as usize;
    let end = entry
        .checked_add(size)
        .filter(|end| *end <= stsd.end)
        .ok_or_else(|| "MP4 audio sample entry extends past stsd.".to_string())?;
    let codec = bytes
        .get(entry + 4..entry + 8)
        .ok_or_else(|| "MP4 audio codec is truncated.".to_string())?;
    if codec != b"mp4a" {
        return Err("Only MP4 AAC audio is supported by the browser demux path.".into());
    }

    let version = be_u16(bytes, entry + 16).unwrap_or(0);
    if version > 1 {
        return Err(format!(
            "MP4 audio sample-entry version {version} is not supported by the browser demux path."
        ));
    }
    let channels = be_u16(bytes, entry + 24).unwrap_or(0) as u32;
    let sample_rate = be_u32(bytes, entry + 32).unwrap_or(0) >> 16;
    if channels == 0 || sample_rate == 0 {
        return Err("MP4 AAC sample rate or channel count is missing.".into());
    }
    let child_start = entry + 36 + if version == 1 { 16 } else { 0 };
    if child_start > end {
        return Err("MP4 AAC sample entry is truncated before codec metadata.".into());
    }
    let esds = mp4_boxes(bytes, child_start, end)
        .into_iter()
        .find(|item| &item.kind == b"esds")
        .ok_or_else(|| "MP4 AAC track has no esds decoder configuration.".to_string())?;
    let description = parse_aac_audio_specific_config(bytes, esds)
        .ok_or_else(|| "MP4 AAC esds has no AudioSpecificConfig.".to_string())?;
    let object_type = description.first().map(|byte| byte >> 3).unwrap_or(0);
    if object_type == 0 {
        return Err("MP4 AAC AudioSpecificConfig has an invalid object type.".into());
    }
    Ok(AudioDecoderConfig {
        codec: format!("mp4a.40.{object_type}"),
        sample_rate,
        channels,
        description,
    })
}

fn parse_aac_audio_specific_config(bytes: &[u8], esds: Mp4Box) -> Option<Vec<u8>> {
    let start = esds.payload_start.checked_add(4)?;
    let (tag, payload_start, payload_end) = descriptor(bytes, start, esds.end)?;
    if tag != 0x03 || payload_start + 3 > payload_end {
        return None;
    }
    let flags = bytes[payload_start + 2];
    let mut cursor = payload_start + 3;
    if flags & 0x80 != 0 {
        cursor = cursor.checked_add(2)?;
    }
    if flags & 0x40 != 0 {
        let url_len = *bytes.get(cursor)? as usize;
        cursor = cursor.checked_add(1 + url_len)?;
    }
    if flags & 0x20 != 0 {
        cursor = cursor.checked_add(2)?;
    }
    let (tag, decoder_start, decoder_end) = descriptor(bytes, cursor, payload_end)?;
    if tag != 0x04 || decoder_start + 13 > decoder_end {
        return None;
    }
    let (tag, config_start, config_end) =
        descriptor(bytes, decoder_start + 13, decoder_end)?;
    if tag != 0x05 || config_start >= config_end {
        return None;
    }
    Some(bytes[config_start..config_end].to_vec())
}

fn descriptor(bytes: &[u8], offset: usize, end: usize) -> Option<(u8, usize, usize)> {
    let tag = *bytes.get(offset)?;
    let mut cursor = offset + 1;
    let mut length = 0_usize;
    for _ in 0..4 {
        let byte = *bytes.get(cursor)?;
        cursor += 1;
        length = length.checked_mul(128)?.checked_add((byte & 0x7f) as usize)?;
        if byte & 0x80 == 0 {
            let payload_end = cursor.checked_add(length)?;
            if payload_end <= end {
                return Some((tag, cursor, payload_end));
            }
            return None;
        }
    }
    None
}

fn build_audio_batches(mut chunks: Vec<AudioChunk>) -> Result<VecDeque<AudioBatch>, String> {
    chunks.sort_by_key(|chunk| chunk.offset);
    let mut batches = VecDeque::new();
    let mut current: Option<AudioBatch> = None;

    for chunk in chunks {
        if chunk.length == 0 {
            continue;
        }
        if chunk.length as u64 > MAX_AUDIO_BATCH_BYTES {
            return Err("An encoded audio sample exceeds the browser audio batch limit.".into());
        }
        let chunk_end = chunk.offset.saturating_add(chunk.length as u64);
        let should_join = current.as_ref().is_some_and(|batch| {
            let batch_end = batch.offset.saturating_add(batch.length as u64);
            let gap = chunk.offset.saturating_sub(batch_end);
            let span = chunk_end.saturating_sub(batch.offset);
            gap <= MAX_AUDIO_SAMPLE_GAP_BYTES && span <= MAX_AUDIO_BATCH_BYTES
        });
        if should_join {
            let batch = current.as_mut().expect("batch exists");
            batch.length = (chunk_end - batch.offset) as u32;
            batch.chunks.push(chunk);
            continue;
        }
        if let Some(batch) = current.take() {
            batches.push_back(batch);
        }
        current = Some(AudioBatch {
            offset: chunk.offset,
            length: chunk.length,
            chunks: vec![chunk],
        });
    }
    if let Some(batch) = current {
        batches.push_back(batch);
    }
    Ok(batches)
}

fn parse_matroska_audio_track(bytes: &[u8]) -> Option<MatroskaAudioTrack> {
    let tracks = EbmlElement {
        id: 0x1654_AE6B,
        payload_start: 0,
        end: bytes.len(),
    };
    for entry in ebml_elements(bytes, tracks.payload_start, tracks.end)
        .into_iter()
        .filter(|item| item.id == 0xAE)
    {
        let mut number = 0_u64;
        let mut track_type = 0_u64;
        let mut codec = String::new();
        let mut sample_rate = 48_000_u32;
        let mut channels = 1_u32;
        for item in ebml_elements(bytes, entry.payload_start, entry.end) {
            match item.id {
                0xD7 => number = ebml_uint(bytes, item).unwrap_or(0),
                0x83 => track_type = ebml_uint(bytes, item).unwrap_or(0),
                0x86 => {
                    codec = String::from_utf8_lossy(&bytes[item.payload_start..item.end]).into_owned()
                }
                0xE1 => {
                    for audio in ebml_elements(bytes, item.payload_start, item.end) {
                        match audio.id {
                            0xB5 => {
                                if let Some(value) = ebml_float(bytes, audio) {
                                    if value.is_finite() && value > 0.0 {
                                        sample_rate = value.round() as u32;
                                    }
                                }
                            }
                            0x9F => {
                                channels = ebml_uint(bytes, audio)
                                    .and_then(|value| u32::try_from(value).ok())
                                    .filter(|value| *value > 0)
                                    .unwrap_or(channels);
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        if track_type == 2 && number != 0 && codec == "A_OPUS" {
            return Some(MatroskaAudioTrack {
                number,
                codec,
                sample_rate,
                channels,
            });
        }
    }
    None
}

fn parse_laced_packet_ranges(
    block: &[u8],
    data_start: usize,
    flags: u8,
) -> Result<Vec<(usize, usize)>, String> {
    if data_start > block.len() {
        return Ok(Vec::new());
    }
    let lacing = (flags & 0x06) >> 1;
    if lacing == 0 {
        return Ok(if data_start < block.len() {
            vec![(data_start, block.len())]
        } else {
            Vec::new()
        });
    }

    let mut cursor = data_start;
    let lace_count = *block
        .get(cursor)
        .ok_or_else(|| "Matroska lacing header is truncated.".to_string())?
        as usize
        + 1;
    cursor += 1;
    if lace_count < 2 {
        return Err("Matroska lacing declared an invalid packet count.".into());
    }

    let mut sizes = Vec::with_capacity(lace_count);
    match lacing {
        1 => {
            for _ in 0..lace_count - 1 {
                let mut size = 0_usize;
                loop {
                    let value = *block
                        .get(cursor)
                        .ok_or_else(|| "Matroska Xiph lacing header is truncated.".to_string())?;
                    cursor += 1;
                    size = size
                        .checked_add(value as usize)
                        .ok_or_else(|| "Matroska Xiph lace size overflowed.".to_string())?;
                    if value != 255 {
                        break;
                    }
                }
                sizes.push(size);
            }
        }
        2 => {
            let remaining = block.len().saturating_sub(cursor);
            if remaining % lace_count != 0 {
                return Err("Matroska fixed lacing does not divide the block payload evenly.".into());
            }
            sizes.resize(lace_count - 1, remaining / lace_count);
        }
        3 => {
            let (first, width, _) = read_ebml_vint(block, cursor, false)
                .ok_or_else(|| "Matroska EBML lacing first size is truncated.".to_string())?;
            cursor += width;
            let mut previous = i64::try_from(first)
                .map_err(|_| "Matroska EBML lace size is too large.".to_string())?;
            sizes.push(previous as usize);
            for _ in 1..lace_count - 1 {
                let (encoded, width, _) = read_ebml_vint(block, cursor, false)
                    .ok_or_else(|| "Matroska EBML lace delta is truncated.".to_string())?;
                cursor += width;
                let bits = 7 * width;
                let bias = (1_i64 << (bits - 1)) - 1;
                let delta = i64::try_from(encoded)
                    .map_err(|_| "Matroska EBML lace delta is too large.".to_string())?
                    - bias;
                previous = previous
                    .checked_add(delta)
                    .filter(|value| *value >= 0)
                    .ok_or_else(|| "Matroska EBML lace size became negative.".to_string())?;
                sizes.push(previous as usize);
            }
        }
        _ => return Err("Unknown Matroska lacing mode.".into()),
    }

    let declared: usize = sizes.iter().sum();
    let remaining = block.len().saturating_sub(cursor);
    if declared > remaining {
        return Err("Matroska lace sizes exceed the block payload.".into());
    }
    sizes.push(remaining - declared);

    let mut ranges = Vec::with_capacity(lace_count);
    for size in sizes {
        let end = cursor
            .checked_add(size)
            .filter(|end| *end <= block.len())
            .ok_or_else(|| "Matroska laced packet extends past its block.".to_string())?;
        ranges.push((cursor, end));
        cursor = end;
    }
    Ok(ranges)
}

fn opus_packet_duration_us(packet: &[u8]) -> Option<u64> {
    let toc = *packet.first()?;
    let config = toc >> 3;
    let frame_duration_us = match config {
        0..=11 => match config & 0x03 {
            0 => 10_000,
            1 => 20_000,
            2 => 40_000,
            _ => 60_000,
        },
        12..=15 => {
            if config & 0x01 == 0 {
                10_000
            } else {
                20_000
            }
        }
        _ => 2_500_u64 << (config & 0x03),
    };
    let frames = match toc & 0x03 {
        0 => 1_u64,
        1 | 2 => 2_u64,
        _ => u64::from(*packet.get(1)? & 0x3f),
    };
    let duration = frame_duration_us.saturating_mul(frames);
    (duration <= 120_000 && duration > 0).then_some(duration)
}

fn parse_mp4_header(bytes: &[u8], offset: u64, file_len: u64) -> Result<Mp4Header, String> {
    if bytes.len() < 8 {
        return Err("MP4 box header is truncated.".into());
    }
    let size32 = u32::from_be_bytes(bytes[0..4].try_into().expect("four bytes")) as u64;
    let kind = bytes[4..8].try_into().expect("four bytes");
    let (size, header_size) = if size32 == 1 {
        if bytes.len() < 16 {
            return Err("Extended MP4 box header is truncated.".into());
        }
        (
            u64::from_be_bytes(bytes[8..16].try_into().expect("eight bytes")),
            16_u64,
        )
    } else if size32 == 0 {
        (file_len.saturating_sub(offset), 8_u64)
    } else {
        (size32, 8_u64)
    };
    if size < header_size {
        return Err("MP4 box size is smaller than its header.".into());
    }
    let end = offset
        .checked_add(size)
        .filter(|end| *end <= file_len)
        .ok_or_else(|| "MP4 box extends past the end of the file.".to_string())?;
    Ok(Mp4Header { kind, end })
}

fn parse_ebml_header(bytes: &[u8], offset: u64, scope_end: u64) -> Result<EbmlHeader, String> {
    let (id, id_width, _) = read_ebml_vint(bytes, 0, true)
        .ok_or_else(|| "Matroska element id is truncated.".to_string())?;
    let (size, size_width, unknown) = read_ebml_vint(bytes, id_width, false)
        .ok_or_else(|| "Matroska element size is truncated.".to_string())?;
    let header_width = (id_width + size_width) as u64;
    let payload_offset = offset
        .checked_add(header_width)
        .ok_or_else(|| "Matroska element offset overflowed.".to_string())?;
    let end = if unknown {
        scope_end
    } else {
        payload_offset
            .checked_add(size)
            .filter(|end| *end <= scope_end)
            .ok_or_else(|| "Matroska element extends past its parent scope.".to_string())?
    };
    Ok(EbmlHeader {
        id,
        payload_offset,
        payload_length: end.saturating_sub(payload_offset),
        end,
    })
}

fn units_to_us(units: u64, timescale: u64) -> u64 {
    if timescale == 0 {
        0
    } else {
        units.saturating_mul(1_000_000) / timescale
    }
}

fn read_length(end: u64, offset: u64, wanted: u64) -> u32 {
    end.saturating_sub(offset).min(wanted).min(u32::MAX as u64) as u32
}

fn checked_read_length(length: u64) -> Result<u32, String> {
    u32::try_from(length).map_err(|_| "Requested audio range is too large for one WASM transfer.".into())
}

fn ensure_metadata_size(length: u64, label: &str) -> Result<(), String> {
    if length > MAX_METADATA_BYTES {
        return Err(format!(
            "{label} is {} MiB, above the {} MiB browser metadata limit.",
            length / (1024 * 1024),
            MAX_METADATA_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

unsafe fn demux_mut<'a>(handle: u32) -> Option<&'a mut AudioDemux> {
    if handle == 0 {
        None
    } else {
        unsafe { (handle as *mut AudioDemux).as_mut() }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_demux_create(file_len: u64) -> u32 {
    Box::into_raw(Box::new(AudioDemux::new(file_len))) as u32
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn audio_demux_poll(handle: u32) -> u64 {
    let Some(session) = (unsafe { demux_mut(handle) }) else {
        return return_json(
            "{\"status\":\"error\",\"message\":\"Invalid audio demux session.\"}".into(),
        );
    };
    return_json(session.poll_json())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn audio_demux_supply(
    handle: u32,
    offset: u64,
    ptr: u32,
    len: u32,
) -> u32 {
    let Some(session) = (unsafe { demux_mut(handle) }) else {
        return 0;
    };
    let bytes = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    session.supply(offset, bytes);
    1
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn audio_demux_acknowledge(handle: u32) -> u32 {
    let Some(session) = (unsafe { demux_mut(handle) }) else {
        return 0;
    };
    u32::from(session.acknowledge())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn audio_demux_destroy(handle: u32) {
    if handle != 0 {
        unsafe {
            drop(Box::from_raw(handle as *mut AudioDemux));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_packet_duration_is_bounded() {
        assert_eq!(opus_packet_duration_us(&[0b0000_0000]), Some(10_000));
        assert_eq!(opus_packet_duration_us(&[0b0000_1001]), Some(40_000));
        assert_eq!(opus_packet_duration_us(&[0b1000_0000]), Some(2_500));
    }

    #[test]
    fn fixed_lacing_splits_payload_without_copying_packets() {
        let mut block = vec![0x81, 0, 0, 0x04, 1];
        block.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
        let ranges = parse_laced_packet_ranges(&block, 4, 0x04).expect("ranges");
        assert_eq!(ranges, vec![(5, 8), (8, 11)]);
    }

    #[test]
    fn audio_batches_remain_bounded() {
        let chunks = vec![
            AudioChunk {
                offset: 100,
                length: 20,
                timestamp_us: 0,
                duration_us: Some(20_000),
            },
            AudioChunk {
                offset: 140,
                length: 20,
                timestamp_us: 20_000,
                duration_us: Some(20_000),
            },
            AudioChunk {
                offset: 2_000_000,
                length: 20,
                timestamp_us: 40_000,
                duration_us: Some(20_000),
            },
        ];
        let batches = build_audio_batches(chunks).expect("batches");
        assert_eq!(batches.len(), 2);
        assert!(batches.iter().all(|batch| batch.length as u64 <= MAX_AUDIO_BATCH_BYTES));
    }
}
