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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum JobPhase {
    Queued,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobProgress {
    state: JobState,
    phase: JobPhase,
}

impl JobProgress {
    pub(super) const fn running(phase: JobPhase) -> Self {
        Self {
            state: JobState::Running,
            phase,
        }
    }
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
        TranscriptionProgressEvent::TaskStart { task, .. }
        | TranscriptionProgressEvent::TaskEnd { task, .. }
        | TranscriptionProgressEvent::ModelResolutionStart { task, .. }
        | TranscriptionProgressEvent::ModelResolutionEnd { task, .. }
        | TranscriptionProgressEvent::ModelDownloadStart { task, .. }
        | TranscriptionProgressEvent::ModelDownloadEnd { task, .. }
        | TranscriptionProgressEvent::ModelLoadStart { task, .. }
        | TranscriptionProgressEvent::ModelLoadEnd { task, .. }
        | TranscriptionProgressEvent::ModelReuse { task, .. } => Some(phase_for_task(*task)),
        TranscriptionProgressEvent::TranslationLegStart { .. }
        | TranscriptionProgressEvent::TranslationLegEnd { .. } => Some(JobPhase::Translating),
        TranscriptionProgressEvent::Failure {
            task: Some(task), ..
        }
        | TranscriptionProgressEvent::Cancelled {
            task: Some(task), ..
        } => Some(phase_for_task(*task)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{JobPhase, JobProgress, JobState, phase_for_task};
    use native_whisperx::TranscriptionProgressTask;

    #[test]
    fn lifecycle_contract_serializes_to_stable_camel_case_values() {
        assert_eq!(
            serde_json::to_string(&JobState::Queued).unwrap(),
            "\"queued\""
        );
        assert_eq!(
            serde_json::to_string(&JobPhase::DetectingSpeech).unwrap(),
            "\"detectingSpeech\""
        );
        assert_eq!(
            serde_json::to_string(&JobPhase::WritingOutput).unwrap(),
            "\"writingOutput\""
        );
        assert_eq!(
            serde_json::to_value(JobProgress::running(JobPhase::Aligning)).unwrap(),
            serde_json::json!({ "state": "running", "phase": "aligning" })
        );
    }

    #[test]
    fn every_job_state_has_a_stable_wire_value() {
        let cases = [
            (JobState::Queued, "queued"),
            (JobState::Running, "running"),
            (JobState::Completed, "completed"),
            (JobState::Cancelled, "cancelled"),
            (JobState::Failed, "failed"),
        ];

        for (state, expected) in cases {
            assert_eq!(serde_json::to_value(state).unwrap(), expected);
        }
    }

    #[test]
    fn every_job_phase_has_a_stable_wire_value() {
        let cases = [
            (JobPhase::Queued, "queued"),
            (JobPhase::Decoding, "decoding"),
            (JobPhase::DetectingSpeech, "detectingSpeech"),
            (JobPhase::Transcribing, "transcribing"),
            (JobPhase::Aligning, "aligning"),
            (JobPhase::Diarizing, "diarizing"),
            (JobPhase::Translating, "translating"),
            (JobPhase::WritingOutput, "writingOutput"),
            (JobPhase::Completed, "completed"),
            (JobPhase::Cancelled, "cancelled"),
            (JobPhase::Failed, "failed"),
        ];

        for (phase, expected) in cases {
            assert_eq!(serde_json::to_value(phase).unwrap(), expected);
        }
    }

    #[test]
    fn native_tasks_map_to_application_phases() {
        let cases = [
            (TranscriptionProgressTask::Decode, JobPhase::Decoding),
            (TranscriptionProgressTask::Vad, JobPhase::DetectingSpeech),
            (TranscriptionProgressTask::Asr, JobPhase::Transcribing),
            (TranscriptionProgressTask::Alignment, JobPhase::Aligning),
            (TranscriptionProgressTask::Diarization, JobPhase::Diarizing),
            (TranscriptionProgressTask::Translation, JobPhase::Translating),
            (TranscriptionProgressTask::Output, JobPhase::WritingOutput),
        ];

        for (task, expected) in cases {
            assert_eq!(phase_for_task(task), expected);
        }
    }
}
