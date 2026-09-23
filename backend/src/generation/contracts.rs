use native_whisperx::{TranscriptionProgressEvent, TranscriptionProgressTask};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum JobState {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl JobState {
    pub(super) const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum JobPhase {
    Queued,
    CheckingModels,
    DownloadingModels,
    LoadingModels,
    Decoding,
    DetectingSpeech,
    Transcribing,
    Aligning,
    Diarizing,
    Translating,
    WritingOutput,
    Completed,
    Cancelled,
    Failed,
}

pub(super) const fn phase_for_task(task: TranscriptionProgressTask) -> JobPhase {
    match task {
        TranscriptionProgressTask::Decode => JobPhase::Decoding,
        TranscriptionProgressTask::Vad => JobPhase::DetectingSpeech,
        TranscriptionProgressTask::Asr => JobPhase::Transcribing,
        TranscriptionProgressTask::Alignment => JobPhase::Aligning,
        TranscriptionProgressTask::Diarization => JobPhase::Diarizing,
        TranscriptionProgressTask::Translation => JobPhase::Translating,
        TranscriptionProgressTask::Output => JobPhase::WritingOutput,
    }
}

pub(super) fn phase_for_event(event: &TranscriptionProgressEvent) -> Option<JobPhase> {
    match event {
        TranscriptionProgressEvent::ModelResolutionStart { .. } => Some(JobPhase::CheckingModels),
        TranscriptionProgressEvent::ModelDownloadStart { .. } => Some(JobPhase::DownloadingModels),
        TranscriptionProgressEvent::ModelLoadStart { .. } => Some(JobPhase::LoadingModels),
        TranscriptionProgressEvent::TaskStart { task, .. }
        | TranscriptionProgressEvent::TaskEnd { task, .. }
        | TranscriptionProgressEvent::ModelResolutionEnd { task, .. }
        | TranscriptionProgressEvent::ModelDownloadEnd { task, .. }
        | TranscriptionProgressEvent::ModelLoadEnd { task, .. }
        | TranscriptionProgressEvent::ModelReuse { task, .. } => Some(phase_for_task(*task)),
        TranscriptionProgressEvent::TranslationLegStart { .. }
        | TranscriptionProgressEvent::TranslationLegEnd { .. } => Some(JobPhase::Translating),
        TranscriptionProgressEvent::Failure { task: Some(task), .. }
        | TranscriptionProgressEvent::Cancelled { task: Some(task), .. } => Some(phase_for_task(*task)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_have_stable_wire_values_and_terminal_semantics() {
        for (state, name, terminal) in [
            (JobState::Queued, "queued", false),
            (JobState::Running, "running", false),
            (JobState::Completed, "completed", true),
            (JobState::Cancelled, "cancelled", true),
            (JobState::Failed, "failed", true),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), name);
            assert_eq!(state.is_terminal(), terminal);
        }
    }

    #[test]
    fn model_setup_has_distinct_wire_phases() {
        for (phase, name) in [
            (JobPhase::CheckingModels, "checkingModels"),
            (JobPhase::DownloadingModels, "downloadingModels"),
            (JobPhase::LoadingModels, "loadingModels"),
            (JobPhase::DetectingSpeech, "detectingSpeech"),
            (JobPhase::WritingOutput, "writingOutput"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), name);
        }
    }

    #[test]
    fn native_tasks_map_to_application_phases() {
        for (task, phase) in [
            (TranscriptionProgressTask::Decode, JobPhase::Decoding),
            (TranscriptionProgressTask::Vad, JobPhase::DetectingSpeech),
            (TranscriptionProgressTask::Asr, JobPhase::Transcribing),
            (TranscriptionProgressTask::Alignment, JobPhase::Aligning),
            (TranscriptionProgressTask::Diarization, JobPhase::Diarizing),
            (TranscriptionProgressTask::Translation, JobPhase::Translating),
            (TranscriptionProgressTask::Output, JobPhase::WritingOutput),
        ] {
            assert_eq!(phase_for_task(task), phase);
        }
    }
}
