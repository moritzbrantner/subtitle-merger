use std::collections::{BTreeMap, VecDeque};

use super::{
    build_mp4_sample_offsets, child_box, decode_matroska_subtitle, decode_mp4_sample,
    ebml_elements, ebml_float, ebml_uint, expand_mp4_timings, matroska_format,
    matroska_text_codec, mp4_boxes, parse_hdlr, parse_mdhd, parse_matroska_tracks,
    parse_mp4_sample_table, parse_mvhd_duration, parse_tkhd_id, push_json_string,
    read_ebml_vint, return_json, units_to_ms, video_inspection_json, Cue, EbmlElement,
    MatroskaTrackMeta, Mp4Box, SubtitleTrack, UnsupportedTrack, VideoInspection,
};

const HEADER_READ_BYTES: u32 = 32;
const MAX_METADATA_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SAMPLE_BATCH_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SAMPLE_GAP_BYTES: u64 = 64 * 1024;
const MAX_SUBTITLE_BLOCK_BYTES: u64 = 16 * 1024 * 1024;

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
    Mp4SampleBatch(Mp4SampleBatch),
    MatroskaHeader,
    MatroskaInfo { scope_depth: usize },
    MatroskaTracks { scope_depth: usize },
    MatroskaTimestampScale { scope_depth: usize },
    MatroskaDuration { scope_depth: usize },
    MatroskaClusterTime { scope_depth: usize },
    MatroskaBlockDuration { scope_depth: usize },
    MatroskaBlockPrefix {
        payload_offset: u64,
        payload_length: u64,
        cluster_time: i64,
        group_depth: Option<usize>,
    },
    MatroskaBlockPayload {
        cluster_time: i64,
        group_depth: Option<usize>,
    },
}

#[derive(Debug)]
struct RangeInspection {
    file_len: u64,
    state: InspectionState,
    pending: Option<ReadRequest>,
    result: Option<Result<VideoInspection, String>>,
}

#[derive(Debug)]
enum InspectionState {
    Detect,
    Mp4(Mp4State),
    Matroska(MatroskaState),
}

#[derive(Debug)]
struct Mp4State {
    scan_offset: u64,
    duration_ms: Option<u64>,
    tracks: Vec<SubtitleTrack>,
    unsupported: Vec<UnsupportedTrack>,
    warnings: Vec<String>,
    sample_batches: VecDeque<Mp4SampleBatch>,
    metadata_ready: bool,
}

#[derive(Debug, Clone)]
struct PlannedMp4Sample {
    track_index: usize,
    offset: u64,
    size: u32,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Clone)]
struct Mp4SampleBatch {
    offset: u64,
    length: u32,
    samples: Vec<PlannedMp4Sample>,
}

#[derive(Debug)]
struct MatroskaState {
    scopes: Vec<MatroskaScope>,
    segment_seen: bool,
    timestamp_scale: u64,
    duration_ticks: Option<f64>,
    subtitle_meta: BTreeMap<u64, MatroskaTrackMeta>,
    track_cues: BTreeMap<u64, Vec<Cue>>,
    warnings: Vec<String>,
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
    BlockGroup {
        cluster_time: i64,
        duration_ticks: Option<u64>,
        pending: Vec<PendingMatroskaCue>,
    },
}

#[derive(Debug)]
struct PendingMatroskaCue {
    track_number: u64,
    start_ms: u64,
    text: String,
}

#[derive(Debug, Clone, Copy)]
struct Mp4Header {
    kind: [u8; 4],
    payload_offset: u64,
    end: u64,
}

#[derive(Debug, Clone, Copy)]
struct EbmlHeader {
    id: u64,
    payload_offset: u64,
    payload_length: u64,
    end: u64,
}

impl RangeInspection {
    fn new(file_len: u64) -> Self {
        let mut value = Self {
            file_len,
            state: InspectionState::Detect,
            pending: None,
            result: None,
        };
        if file_len == 0 {
            value.finish_unknown("The selected video file is empty.");
        } else {
            value.pending = Some(ReadRequest {
                offset: 0,
                length: read_length(file_len, 0, HEADER_READ_BYTES as u64),
                phase: "Detecting container",
                purpose: ReadPurpose::Detect,
            });
        }
        value
    }

    fn poll_json(&mut self) -> String {
        if self.pending.is_none() && self.result.is_none() {
            self.advance();
        }

        if let Some(result) = &self.result {
            return match result {
                Ok(inspection) => format!(
                    "{{\"status\":\"done\",\"inspection\":{}}}",
                    video_inspection_json(inspection)
                ),
                Err(message) => {
                    let mut json = String::from("{\"status\":\"error\",\"message\":");
                    push_json_string(&mut json, message);
                    json.push('}');
                    json
                }
            };
        }

        let Some(request) = &self.pending else {
            return "{\"status\":\"error\",\"message\":\"Inspection stalled without a read request.\"}".into();
        };
        let mut json = format!(
            "{{\"status\":\"read\",\"offset\":{},\"length\":{},\"phase\":",
            request.offset, request.length
        );
        push_json_string(&mut json, request.phase);
        json.push('}');
        json
    }

    fn supply(&mut self, offset: u64, bytes: &[u8]) {
        if self.result.is_some() {
            return;
        }
        let Some(request) = self.pending.take() else {
            self.fail("Rust did not request this video range.");
            return;
        };
        if offset != request.offset || bytes.len() != request.length as usize {
            self.fail(&format!(
                "Video range mismatch: requested {}..{}, received {} bytes at {}.",
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
            ReadPurpose::Mp4SampleBatch(batch) => self.consume_mp4_sample_batch(&batch, bytes),
            ReadPurpose::MatroskaHeader => self.consume_matroska_header(offset, bytes),
            ReadPurpose::MatroskaInfo { scope_depth } => {
                self.consume_matroska_info(scope_depth, bytes)
            }
            ReadPurpose::MatroskaTracks { scope_depth } => {
                self.consume_matroska_tracks(scope_depth, bytes)
            }
            ReadPurpose::MatroskaTimestampScale { scope_depth } => {
                self.consume_matroska_uint(scope_depth, bytes, MatroskaUintTarget::TimestampScale)
            }
            ReadPurpose::MatroskaDuration { scope_depth } => {
                self.consume_matroska_duration(scope_depth, bytes)
            }
            ReadPurpose::MatroskaClusterTime { scope_depth } => {
                self.consume_matroska_uint(scope_depth, bytes, MatroskaUintTarget::ClusterTime)
            }
            ReadPurpose::MatroskaBlockDuration { scope_depth } => {
                self.consume_matroska_uint(scope_depth, bytes, MatroskaUintTarget::BlockDuration)
            }
            ReadPurpose::MatroskaBlockPrefix {
                payload_offset,
                payload_length,
                cluster_time,
                group_depth,
            } => self.consume_matroska_block_prefix(
                payload_offset,
                payload_length,
                cluster_time,
                group_depth,
                bytes,
            ),
            ReadPurpose::MatroskaBlockPayload {
                cluster_time,
                group_depth,
            } => self.consume_matroska_block(cluster_time, group_depth, bytes),
        };
        if let Err(message) = outcome {
            self.fail(&message);
            return;
        }
        self.advance();
    }

    fn consume_detect(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() >= 8 && (&bytes[4..8] == b"ftyp" || &bytes[4..8] == b"moov") {
            self.state = InspectionState::Mp4(Mp4State {
                scan_offset: 0,
                duration_ms: None,
                tracks: Vec::new(),
                unsupported: Vec::new(),
                warnings: Vec::new(),
                sample_batches: VecDeque::new(),
                metadata_ready: false,
            });
            return Ok(());
        }
        if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
            self.state = InspectionState::Matroska(MatroskaState {
                scopes: vec![MatroskaScope {
                    offset: 0,
                    end: self.file_len,
                    kind: MatroskaScopeKind::Top,
                }],
                segment_seen: false,
                timestamp_scale: 1_000_000,
                duration_ticks: None,
                subtitle_meta: BTreeMap::new(),
                track_cues: BTreeMap::new(),
                warnings: Vec::new(),
            });
            return Ok(());
        }
        self.finish_unknown(
            "This browser build currently extracts embedded text subtitles from MP4/MOV and Matroska/WebM containers.",
        );
        Ok(())
    }

    fn advance(&mut self) {
        if self.pending.is_some() || self.result.is_some() {
            return;
        }
        match &mut self.state {
            InspectionState::Detect => {}
            InspectionState::Mp4(state) => {
                if state.metadata_ready {
                    if let Some(batch) = state.sample_batches.pop_front() {
                        self.pending = Some(ReadRequest {
                            offset: batch.offset,
                            length: batch.length,
                            phase: "Reading subtitle samples",
                            purpose: ReadPurpose::Mp4SampleBatch(batch),
                        });
                    } else {
                        let inspection = VideoInspection {
                            container: "mp4".into(),
                            duration_ms: state.duration_ms,
                            tracks: std::mem::take(&mut state.tracks),
                            unsupported: std::mem::take(&mut state.unsupported),
                            warnings: std::mem::take(&mut state.warnings),
                        };
                        self.result = Some(Ok(inspection));
                    }
                    return;
                }
                if state.scan_offset >= self.file_len {
                    self.result = Some(Ok(VideoInspection {
                        container: "mp4".into(),
                        duration_ms: None,
                        tracks: Vec::new(),
                        unsupported: Vec::new(),
                        warnings: vec![
                            "The MP4 has no readable movie metadata (moov box). Fragmented or incomplete files are not supported yet.".into(),
                        ],
                    }));
                    return;
                }
                self.pending = Some(ReadRequest {
                    offset: state.scan_offset,
                    length: read_length(
                        self.file_len,
                        state.scan_offset,
                        HEADER_READ_BYTES as u64,
                    ),
                    phase: "Locating MP4 metadata",
                    purpose: ReadPurpose::Mp4TopHeader,
                });
            }
            InspectionState::Matroska(_) => self.advance_matroska(),
        }
    }

    fn consume_mp4_header(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let header = parse_mp4_header(bytes, offset, self.file_len)?;
        let InspectionState::Mp4(state) = &mut self.state else {
            return Err("MP4 state was lost while scanning the file.".into());
        };
        state.scan_offset = header.end;
        if &header.kind != b"moov" {
            return Ok(());
        }
        let total = header.end.saturating_sub(offset);
        if total > MAX_METADATA_BYTES {
            return Err(format!(
                "The MP4 movie metadata is {} MiB, above the {} MiB browser inspection limit.",
                total / (1024 * 1024),
                MAX_METADATA_BYTES / (1024 * 1024)
            ));
        }
        self.pending = Some(ReadRequest {
            offset,
            length: checked_read_length(total)?,
            phase: "Reading MP4 metadata",
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
            .ok_or_else(|| "The requested MP4 metadata range did not contain a complete moov box.".to_string())?;
        let duration_ms = child_box(bytes, moov, b"mvhd")
            .and_then(|mvhd| parse_mvhd_duration(bytes, mvhd));
        let mut tracks = Vec::new();
        let mut unsupported = Vec::new();
        let mut warnings = Vec::new();
        let mut samples = Vec::new();

        for trak in mp4_boxes(bytes, moov.payload_start, moov.end)
            .into_iter()
            .filter(|item| &item.kind == b"trak")
        {
            match plan_mp4_track(bytes, trak, tracks.len()) {
                Ok(Some(Mp4PlannedTrack::Text { track, planned })) => {
                    tracks.push(track);
                    samples.extend(planned);
                }
                Ok(Some(Mp4PlannedTrack::Unsupported(track))) => unsupported.push(track),
                Ok(None) => {}
                Err(message) => warnings.push(message),
            }
        }

        let batches = build_sample_batches(samples, &mut warnings);
        let InspectionState::Mp4(state) = &mut self.state else {
            return Err("MP4 state was lost after reading metadata.".into());
        };
        state.duration_ms = duration_ms;
        state.tracks = tracks;
        state.unsupported = unsupported;
        state.warnings.extend(warnings);
        state.sample_batches = batches;
        state.metadata_ready = true;
        Ok(())
    }

    fn consume_mp4_sample_batch(
        &mut self,
        batch: &Mp4SampleBatch,
        bytes: &[u8],
    ) -> Result<(), String> {
        let InspectionState::Mp4(state) = &mut self.state else {
            return Err("MP4 state was lost while reading subtitle samples.".into());
        };
        for sample in &batch.samples {
            let relative = sample
                .offset
                .checked_sub(batch.offset)
                .and_then(|value| usize::try_from(value).ok());
            let Some(relative) = relative else {
                state.warnings.push("Skipped an MP4 subtitle sample with an invalid range.".into());
                continue;
            };
            let end = relative.saturating_add(sample.size as usize);
            let Some(payload) = bytes.get(relative..end) else {
                state.warnings.push("Skipped an MP4 subtitle sample outside the supplied range.".into());
                continue;
            };
            let Some(track) = state.tracks.get_mut(sample.track_index) else {
                continue;
            };
            for text in decode_mp4_sample(&track.codec, payload) {
                let text = text.trim();
                if !text.is_empty() {
                    track.cues.push(Cue {
                        start_ms: sample.start_ms,
                        end_ms: sample.end_ms,
                        text: text.to_string(),
                    });
                }
            }
        }
        Ok(())
    }

    fn advance_matroska(&mut self) {
        loop {
            let InspectionState::Matroska(state) = &mut self.state else {
                return;
            };
            let Some(last_index) = state.scopes.len().checked_sub(1) else {
                self.finish_matroska();
                return;
            };
            if state.scopes[last_index].offset >= state.scopes[last_index].end {
                let scope = state.scopes.pop().expect("scope exists");
                finalize_matroska_scope(state, scope);
                continue;
            }
            let offset = state.scopes[last_index].offset;
            let end = state.scopes[last_index].end;
            self.pending = Some(ReadRequest {
                offset,
                length: read_length(end, offset, HEADER_READ_BYTES as u64),
                phase: "Scanning Matroska structure",
                purpose: ReadPurpose::MatroskaHeader,
            });
            return;
        }
    }

    fn consume_matroska_header(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let InspectionState::Matroska(state) = &mut self.state else {
            return Err("Matroska state was lost while scanning the file.".into());
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
                    self.pending = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading Matroska metadata",
                        purpose: ReadPurpose::MatroskaInfo { scope_depth },
                    });
                }
                0x1654_AE6B => {
                    ensure_metadata_size(header.payload_length, "Matroska Tracks")?;
                    self.pending = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading Matroska track metadata",
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
                    self.pending = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading Matroska cluster timing",
                        purpose: ReadPurpose::MatroskaClusterTime { scope_depth },
                    });
                }
                0xA3 => {
                    let cluster_time = *time;
                    self.request_matroska_block_prefix(header, cluster_time, None)?;
                }
                0xA0 => {
                    state.scopes.push(MatroskaScope {
                        offset: header.payload_offset,
                        end: header.end,
                        kind: MatroskaScopeKind::BlockGroup {
                            cluster_time: *time,
                            duration_ticks: None,
                            pending: Vec::new(),
                        },
                    });
                }
                _ => {}
            },
            MatroskaScopeKind::BlockGroup { cluster_time, .. } => match header.id {
                0x9B => {
                    self.pending = Some(ReadRequest {
                        offset: header.payload_offset,
                        length: checked_read_length(header.payload_length)?,
                        phase: "Reading subtitle duration",
                        purpose: ReadPurpose::MatroskaBlockDuration { scope_depth },
                    });
                }
                0xA1 => {
                    let block_cluster_time = *cluster_time;
                    self.request_matroska_block_prefix(
                        header,
                        block_cluster_time,
                        Some(scope_depth),
                    )?;
                }
                _ => {}
            },
        }
        Ok(())
    }

    fn request_matroska_block_prefix(
        &mut self,
        header: EbmlHeader,
        cluster_time: i64,
        group_depth: Option<usize>,
    ) -> Result<(), String> {
        if header.payload_length == 0 {
            return Ok(());
        }
        let prefix = header.payload_length.min(HEADER_READ_BYTES as u64);
        self.pending = Some(ReadRequest {
            offset: header.payload_offset,
            length: checked_read_length(prefix)?,
            phase: "Identifying Matroska block",
            purpose: ReadPurpose::MatroskaBlockPrefix {
                payload_offset: header.payload_offset,
                payload_length: header.payload_length,
                cluster_time,
                group_depth,
            },
        });
        Ok(())
    }

    fn consume_matroska_info(
        &mut self,
        _scope_depth: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        let InspectionState::Matroska(state) = &mut self.state else {
            return Err("Matroska state was lost while reading Info.".into());
        };
        for item in ebml_elements(bytes, 0, bytes.len()) {
            match item.id {
                0x2A_D7_B1 => {
                    state.timestamp_scale = ebml_uint(bytes, item).unwrap_or(state.timestamp_scale)
                }
                0x4489 => state.duration_ticks = ebml_float(bytes, item),
                _ => {}
            }
        }
        Ok(())
    }

    fn consume_matroska_tracks(
        &mut self,
        _scope_depth: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        let InspectionState::Matroska(state) = &mut self.state else {
            return Err("Matroska state was lost while reading Tracks.".into());
        };
        let element = EbmlElement {
            id: 0x1654_AE6B,
            payload_start: 0,
            end: bytes.len(),
        };
        parse_matroska_tracks(bytes, element, &mut state.subtitle_meta);
        for number in state.subtitle_meta.keys().copied() {
            state.track_cues.entry(number).or_default();
        }
        Ok(())
    }

    fn consume_matroska_uint(
        &mut self,
        scope_depth: usize,
        bytes: &[u8],
        target: MatroskaUintTarget,
    ) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > 8 {
            return Err("Matroska integer metadata had an invalid byte width.".into());
        }
        let value = bytes
            .iter()
            .fold(0_u64, |current, byte| (current << 8) | *byte as u64);
        let InspectionState::Matroska(state) = &mut self.state else {
            return Err("Matroska state was lost while reading integer metadata.".into());
        };
        match target {
            MatroskaUintTarget::TimestampScale => state.timestamp_scale = value,
            MatroskaUintTarget::ClusterTime => {
                let Some(scope) = state.scopes.get_mut(scope_depth) else {
                    return Err("Matroska cluster scope disappeared.".into());
                };
                if let MatroskaScopeKind::Cluster { time } = &mut scope.kind {
                    *time = value.min(i64::MAX as u64) as i64;
                }
            }
            MatroskaUintTarget::BlockDuration => {
                let Some(scope) = state.scopes.get_mut(scope_depth) else {
                    return Err("Matroska block-group scope disappeared.".into());
                };
                if let MatroskaScopeKind::BlockGroup { duration_ticks, .. } = &mut scope.kind {
                    *duration_ticks = Some(value);
                }
            }
        }
        Ok(())
    }

    fn consume_matroska_duration(
        &mut self,
        _scope_depth: usize,
        _bytes: &[u8],
    ) -> Result<(), String> {
        Ok(())
    }

    fn consume_matroska_block_prefix(
        &mut self,
        payload_offset: u64,
        payload_length: u64,
        cluster_time: i64,
        group_depth: Option<usize>,
        bytes: &[u8],
    ) -> Result<(), String> {
        let Some((track_number, width, _)) = read_ebml_vint(bytes, 0, false) else {
            return Ok(());
        };
        if bytes.len() < width + 3 {
            return Ok(());
        }
        let flags = bytes[width + 2];
        let InspectionState::Matroska(state) = &mut self.state else {
            return Err("Matroska state was lost while identifying a block.".into());
        };
        let Some(meta) = state.subtitle_meta.get(&track_number) else {
            return Ok(());
        };
        if !matroska_text_codec(&meta.codec) {
            return Ok(());
        }
        if flags & 0x06 != 0 {
            state
                .warnings
                .push(format!("Skipped a laced subtitle block on Matroska track {track_number}."));
            return Ok(());
        }
        if payload_length > MAX_SUBTITLE_BLOCK_BYTES {
            state.warnings.push(format!(
                "Skipped an unusually large Matroska subtitle block on track {track_number}."
            ));
            return Ok(());
        }
        if payload_length as usize <= bytes.len() {
            return self.consume_matroska_block(cluster_time, group_depth, bytes);
        }
        self.pending = Some(ReadRequest {
            offset: payload_offset,
            length: checked_read_length(payload_length)?,
            phase: "Reading Matroska subtitle block",
            purpose: ReadPurpose::MatroskaBlockPayload {
                cluster_time,
                group_depth,
            },
        });
        Ok(())
    }

    fn consume_matroska_block(
        &mut self,
        cluster_time: i64,
        group_depth: Option<usize>,
        block: &[u8],
    ) -> Result<(), String> {
        let Some((track_number, width, _)) = read_ebml_vint(block, 0, false) else {
            return Ok(());
        };
        if block.len() < width + 3 {
            return Ok(());
        }
        let relative = i16::from_be_bytes([block[width], block[width + 1]]) as i64;
        let payload = &block[width + 3..];
        let InspectionState::Matroska(state) = &mut self.state else {
            return Err("Matroska state was lost while decoding a subtitle block.".into());
        };
        let Some(meta) = state.subtitle_meta.get(&track_number) else {
            return Ok(());
        };
        if !matroska_text_codec(&meta.codec) {
            return Ok(());
        }
        let text = decode_matroska_subtitle(&meta.codec, payload);
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let start_ticks = cluster_time.saturating_add(relative).max(0) as u64;
        let start_ms = start_ticks.saturating_mul(state.timestamp_scale) / 1_000_000;

        if let Some(depth) = group_depth {
            let duration = state.scopes.get(depth).and_then(|scope| match &scope.kind {
                MatroskaScopeKind::BlockGroup { duration_ticks, .. } => *duration_ticks,
                _ => None,
            });
            if let Some(duration) = duration {
                let end_ms = start_ms.saturating_add(
                    duration.saturating_mul(state.timestamp_scale) / 1_000_000,
                );
                state.track_cues.entry(track_number).or_default().push(Cue {
                    start_ms,
                    end_ms,
                    text: text.to_string(),
                });
            } else if let Some(scope) = state.scopes.get_mut(depth) {
                if let MatroskaScopeKind::BlockGroup { pending, .. } = &mut scope.kind {
                    pending.push(PendingMatroskaCue {
                        track_number,
                        start_ms,
                        text: text.to_string(),
                    });
                }
            }
        } else {
            state.track_cues.entry(track_number).or_default().push(Cue {
                start_ms,
                end_ms: start_ms,
                text: text.to_string(),
            });
        }
        Ok(())
    }

    fn finish_matroska(&mut self) {
        let InspectionState::Matroska(state) = &mut self.state else {
            return;
        };
        if !state.segment_seen {
            self.result = Some(Ok(VideoInspection {
                container: "matroska".into(),
                duration_ms: None,
                tracks: Vec::new(),
                unsupported: Vec::new(),
                warnings: vec!["The Matroska/WebM file has no readable Segment element.".into()],
            }));
            return;
        }

        let duration_ms = state.duration_ticks.and_then(|duration| {
            if duration.is_finite() && duration >= 0.0 {
                Some((duration * state.timestamp_scale as f64 / 1_000_000.0).round() as u64)
            } else {
                None
            }
        });
        let mut tracks = Vec::new();
        let mut unsupported = Vec::new();
        for (number, meta) in std::mem::take(&mut state.subtitle_meta) {
            if matroska_text_codec(&meta.codec) {
                let mut cues = state.track_cues.remove(&number).unwrap_or_default();
                super::finalize_open_cue_durations(&mut cues);
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
        self.result = Some(Ok(VideoInspection {
            container: "matroska".into(),
            duration_ms,
            tracks,
            unsupported,
            warnings: std::mem::take(&mut state.warnings),
        }));
    }

    fn finish_unknown(&mut self, warning: &str) {
        self.result = Some(Ok(VideoInspection {
            container: "unknown".into(),
            duration_ms: None,
            tracks: Vec::new(),
            unsupported: Vec::new(),
            warnings: vec![warning.into()],
        }));
    }

    fn fail(&mut self, message: &str) {
        self.pending = None;
        self.result = Some(Err(message.to_string()));
    }
}

#[derive(Debug, Clone, Copy)]
enum MatroskaUintTarget {
    TimestampScale,
    ClusterTime,
    BlockDuration,
}

fn finalize_matroska_scope(state: &mut MatroskaState, scope: MatroskaScope) {
    if let MatroskaScopeKind::BlockGroup {
        duration_ticks,
        pending,
        ..
    } = scope.kind
    {
        for cue in pending {
            let end_ms = duration_ticks
                .map(|duration| {
                    cue.start_ms.saturating_add(
                        duration.saturating_mul(state.timestamp_scale) / 1_000_000,
                    )
                })
                .unwrap_or(cue.start_ms);
            state
                .track_cues
                .entry(cue.track_number)
                .or_default()
                .push(Cue {
                    start_ms: cue.start_ms,
                    end_ms,
                    text: cue.text,
                });
        }
    }
}

enum Mp4PlannedTrack {
    Text {
        track: SubtitleTrack,
        planned: Vec<PlannedMp4Sample>,
    },
    Unsupported(UnsupportedTrack),
}

fn plan_mp4_track(
    bytes: &[u8],
    trak: Mp4Box,
    track_index: usize,
) -> Result<Option<Mp4PlannedTrack>, String> {
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
        } else if track_id == 0 {
            "Embedded subtitle track".into()
        } else {
            format!("Embedded subtitle {track_id}")
        }
    } else {
        handler_name
            .trim_matches(char::from(0))
            .trim()
            .to_string()
    };

    if !textual_codec {
        return Ok(Some(Mp4PlannedTrack::Unsupported(UnsupportedTrack {
            title,
            language,
            codec: if table.codec.is_empty() {
                "unknown".into()
            } else {
                table.codec
            },
            reason: "This embedded subtitle codec is not text-decodable in the static browser build.".into(),
        })));
    }
    if timescale == 0 {
        return Err(format!(
            "Skipped MP4 subtitle track {track_id}: missing media timescale."
        ));
    }

    let sample_offsets = build_mp4_sample_offsets(&table)
        .map_err(|message| format!("Skipped MP4 subtitle track {track_id}: {message}"))?;
    let timings = expand_mp4_timings(&table, sample_offsets.len());
    let mut planned = Vec::with_capacity(sample_offsets.len());
    for (index, (offset, size)) in sample_offsets.into_iter().enumerate() {
        let Some((start_units, duration_units)) = timings.get(index).copied() else {
            break;
        };
        let start_ms = units_to_ms(start_units, timescale);
        let end_ms = units_to_ms(start_units.saturating_add(duration_units), timescale).max(start_ms);
        planned.push(PlannedMp4Sample {
            track_index,
            offset,
            size,
            start_ms,
            end_ms,
        });
    }

    Ok(Some(Mp4PlannedTrack::Text {
        track: SubtitleTrack {
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
            cues: Vec::new(),
        },
        planned,
    }))
}

fn build_sample_batches(
    mut samples: Vec<PlannedMp4Sample>,
    warnings: &mut Vec<String>,
) -> VecDeque<Mp4SampleBatch> {
    samples.sort_by_key(|sample| sample.offset);
    let mut batches = VecDeque::new();
    let mut current: Option<Mp4SampleBatch> = None;

    for sample in samples {
        let sample_end = sample.offset.saturating_add(sample.size as u64);
        if sample_end < sample.offset || sample_end > u32::MAX as u64 + sample.offset {
            warnings.push("Skipped an MP4 subtitle sample with an invalid size.".into());
            continue;
        }
        let should_join = current.as_ref().is_some_and(|batch| {
            let batch_end = batch.offset.saturating_add(batch.length as u64);
            let gap = sample.offset.saturating_sub(batch_end);
            let span = sample_end.saturating_sub(batch.offset);
            gap <= MAX_SAMPLE_GAP_BYTES && span <= MAX_SAMPLE_BATCH_BYTES
        });
        if should_join {
            let batch = current.as_mut().expect("batch exists");
            let new_end = sample_end.max(batch.offset.saturating_add(batch.length as u64));
            batch.length = (new_end - batch.offset) as u32;
            batch.samples.push(sample);
            continue;
        }
        if let Some(batch) = current.take() {
            batches.push_back(batch);
        }
        if sample.size as u64 > MAX_SAMPLE_BATCH_BYTES {
            warnings.push("Skipped an unusually large MP4 subtitle sample.".into());
            continue;
        }
        current = Some(Mp4SampleBatch {
            offset: sample.offset,
            length: sample.size,
            samples: vec![sample],
        });
    }
    if let Some(batch) = current {
        batches.push_back(batch);
    }
    batches
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
    Ok(Mp4Header {
        kind,
        payload_offset: offset + header_size,
        end,
    })
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

fn read_length(end: u64, offset: u64, wanted: u64) -> u32 {
    end.saturating_sub(offset).min(wanted).min(u32::MAX as u64) as u32
}

fn checked_read_length(length: u64) -> Result<u32, String> {
    u32::try_from(length).map_err(|_| "Requested video range is too large for one WASM transfer.".into())
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

unsafe fn session_mut<'a>(handle: u32) -> Option<&'a mut RangeInspection> {
    if handle == 0 {
        None
    } else {
        unsafe { (handle as *mut RangeInspection).as_mut() }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn inspection_create(file_len: u64) -> u32 {
    Box::into_raw(Box::new(RangeInspection::new(file_len))) as u32
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn inspection_poll(handle: u32) -> u64 {
    let Some(session) = (unsafe { session_mut(handle) }) else {
        return return_json(
            "{\"status\":\"error\",\"message\":\"Invalid inspection session.\"}".into(),
        );
    };
    return_json(session.poll_json())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn inspection_supply(
    handle: u32,
    offset: u64,
    ptr: u32,
    len: u32,
) -> u32 {
    let Some(session) = (unsafe { session_mut(handle) }) else {
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
pub unsafe extern "C" fn inspection_destroy(handle: u32) {
    if handle != 0 {
        unsafe {
            drop(Box::from_raw(handle as *mut RangeInspection));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_header_can_skip_large_media_box_without_reading_payload() {
        let mut header = vec![0_u8; 32];
        header[0..4].copy_from_slice(&1_000_000_u32.to_be_bytes());
        header[4..8].copy_from_slice(b"mdat");
        let parsed = parse_mp4_header(&header, 24, 2_000_000).expect("header");
        assert_eq!(&parsed.kind, b"mdat");
        assert_eq!(parsed.end, 1_000_024);
        assert_eq!(parsed.payload_offset, 32);
    }

    #[test]
    fn sample_batches_are_bounded_and_coalesce_nearby_subtitles() {
        let samples = vec![
            PlannedMp4Sample {
                track_index: 0,
                offset: 1_000,
                size: 20,
                start_ms: 0,
                end_ms: 1_000,
            },
            PlannedMp4Sample {
                track_index: 0,
                offset: 1_100,
                size: 30,
                start_ms: 2_000,
                end_ms: 3_000,
            },
            PlannedMp4Sample {
                track_index: 0,
                offset: 10_000_000,
                size: 40,
                start_ms: 4_000,
                end_ms: 5_000,
            },
        ];
        let mut warnings = Vec::new();
        let batches = build_sample_batches(samples, &mut warnings);
        assert!(warnings.is_empty());
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].offset, 1_000);
        assert_eq!(batches[0].length, 130);
        assert_eq!(batches[0].samples.len(), 2);
        assert!(batches.iter().all(|batch| batch.length as u64 <= MAX_SAMPLE_BATCH_BYTES));
    }

    #[test]
    fn initial_inspection_reads_only_a_small_header() {
        let mut session = RangeInspection::new(8 * 1024 * 1024 * 1024);
        let json = session.poll_json();
        assert!(json.contains("\"status\":\"read\""));
        assert!(json.contains("\"length\":32"));
        assert!(!json.contains("8589934592"));
    }

    #[test]
    fn ebml_unknown_size_is_bounded_by_parent_scope() {
        let bytes = [0x18, 0x53, 0x80, 0x67, 0xff];
        let header = parse_ebml_header(&bytes, 100, 50_000).expect("header");
        assert_eq!(header.id, 0x1853_8067);
        assert_eq!(header.payload_offset, 105);
        assert_eq!(header.end, 50_000);
    }
}
