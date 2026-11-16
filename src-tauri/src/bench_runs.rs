//! Agent bench and SQL lesson commands. The bundled corpus runs with an explicitly selected
//! classic or native Prime RLM engine and spends model quota. Native memories are not validated.
use crate::*;
use claakecode_app::bench::{self, BenchHarness, BenchTask, BundledTasks, TaskOutcome};
use claakecode_app::lessons::{Lesson, NewLesson};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const MAX_REPETITIONS: u32 = 5;
const VALIDATION_REPETITIONS: u32 = 3;
const BASE_SYSTEM: &str = "You are a coding agent working in the current directory. Complete the task with your tools, verify your work, then stop.";

/// One bench at a time: the cancel handle of the running task, if any.
static ACTIVE: Mutex<Option<TurnCancel>> = Mutex::new(None);

struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}

fn begin() -> Result<ActiveGuard, String> {
    let mut active = ACTIVE.lock().map_err(error_to_string)?;
    if active.is_some() {
        return Err("a bench run is already active".into());
    }
    *active = Some(TurnCancel::empty());
    Ok(ActiveGuard)
}

fn stopped() -> bool {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(TurnCancel::is_cancelled))
        .unwrap_or(true)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartBenchRunInput {
    provider_id: String,
    model_id: String,
    tags: Vec<String>,
    repetitions: u32,
    harness: BenchHarness,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BenchRunReport {
    provider: String,
    model: String,
    #[serde(default)]
    harness: BenchHarness,
    tags: Vec<String>,
    started_at_ms: i64,
    outcomes: Vec<TaskOutcome>,
    stopped: bool,
}

/// Runs `tasks` x `repetitions` in sequence; stops between tasks (and inside one) on cancel.
async fn run_series(
    app: &AppHandle,
    state: &DesktopState,
    provider: Option<&Arc<dyn Provider>>,
    model: &ModelRef,
    harness: BenchHarness,
    corpus: &BundledTasks,
    tasks: &[&BenchTask],
    repetitions: u32,
    extra_system: Option<&str>,
    label: &str,
) -> Vec<TaskOutcome> {
    let total = tasks.len() as u32 * repetitions;
    let mut outcomes = Vec::new();
    for task in tasks {
        for _ in 0..repetitions {
            if stopped() {
                return outcomes;
            }
            let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
            let cancel = match ACTIVE.lock().ok().and_then(|active| active.clone()) {
                Some(cancel) => cancel,
                None => return outcomes,
            };
            cancel.register(cmd_tx);
            let task_dir = corpus.task_dir(task);
            let outcome = match harness {
                BenchHarness::Classic => {
                    bench::run_task(
                        provider
                            .expect("classic provider resolved before starting")
                            .clone(),
                        model.clone(),
                        task,
                        &task_dir,
                        state.store.clone(),
                        BASE_SYSTEM,
                        extra_system,
                        Some((cancel, cmd_rx)),
                    )
                    .await
                }
                BenchHarness::Rlm => {
                    bench::run_rlm_task(
                        task,
                        &task_dir,
                        BASE_SYSTEM,
                        extra_system,
                        cancel,
                        cmd_rx,
                        |data_root, workspace, prompt| async move {
                            crate::rlm::create_bench_rlm_session(
                                state,
                                &data_root,
                                &workspace,
                                &model.provider,
                                &model.name,
                                &prompt,
                            )
                            .await
                            .map_err(anyhow::Error::msg)
                        },
                    )
                    .await
                }
            };
            let failed_to_run = outcome.error.is_some();
            outcomes.push(outcome.clone());
            let _ = app.emit(
                "bench-run-progress",
                json!({ "harness": harness, "label": label, "completed": outcomes.len(), "total": total, "outcome": outcome }),
            );
            if failed_to_run {
                return outcomes;
            }
        }
    }
    outcomes
}

#[tauri::command]
pub(super) async fn start_bench_run(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: StartBenchRunInput,
) -> Result<BenchRunReport, String> {
    if input.tags.is_empty() {
        return Err("at least one tag is required: each task spends model quota".into());
    }
    if input.repetitions == 0 || input.repetitions > MAX_REPETITIONS {
        return Err(format!(
            "repetitions must be between 1 and {MAX_REPETITIONS}"
        ));
    }
    let provider = match input.harness {
        BenchHarness::Classic => Some(provider_from_registry(&state, &input.provider_id)?),
        BenchHarness::Rlm => None,
    };
    let model = ModelRef::new(&input.provider_id, &input.model_id);
    let corpus = BundledTasks::load().map_err(error_to_string)?;
    let selected: Vec<&BenchTask> = corpus
        .tasks
        .iter()
        .filter(|task| task.tags.iter().any(|tag| input.tags.contains(tag)))
        .collect();
    if selected.is_empty() {
        return Err("no bench task has one of these tags".into());
    }
    let _active = begin()?;
    let started_at_ms = chrono_now_ms();
    let outcomes = run_series(
        &app,
        &state,
        provider.as_ref(),
        &model,
        input.harness,
        &corpus,
        &selected,
        input.repetitions,
        None,
        "bench",
    )
    .await;
    let report = BenchRunReport {
        provider: input.provider_id,
        model: input.model_id,
        harness: input.harness,
        tags: input.tags,
        started_at_ms,
        stopped: stopped(),
        outcomes,
    };
    let mut history: Vec<BenchRunReport> = state
        .store
        .load_json_setting("bench_runs")
        .ok()
        .flatten()
        .unwrap_or_default();
    history.push(report.clone());
    let keep = history.len().saturating_sub(20);
    state
        .store
        .save_json_setting("bench_runs", &history[keep..].to_vec())
        .map_err(error_to_string)?;
    Ok(report)
}

#[tauri::command]
pub(super) fn stop_bench_run() -> Result<(), String> {
    match ACTIVE.lock().map_err(error_to_string)?.as_ref() {
        Some(cancel) => {
            cancel.cancel_all();
            Ok(())
        }
        None => Err("no bench run is active".into()),
    }
}

#[tauri::command]
pub(super) fn get_bench_runs(
    state: State<'_, DesktopState>,
) -> Result<Vec<BenchRunReport>, String> {
    state
        .store
        .load_json_setting("bench_runs")
        .map_err(error_to_string)
        .map(|runs| runs.unwrap_or_default())
}

/// Lot D5: 3 runs without the lesson, 3 with it, on the tasks sharing its tags; then the verdict.
#[tauri::command]
pub(super) async fn validate_lesson(
    app: AppHandle,
    state: State<'_, DesktopState>,
    lesson_id: String,
    provider_id: String,
    model_id: String,
    harness: BenchHarness,
) -> Result<Lesson, String> {
    let find = |state: &DesktopState| -> Result<Lesson, String> {
        state
            .store
            .list_lessons(None)
            .map_err(error_to_string)?
            .into_iter()
            .find(|lesson| lesson.id == lesson_id)
            .ok_or_else(|| "lesson not found".to_string())
    };
    let lesson = find(&state)?;
    let provider = match harness {
        BenchHarness::Classic => Some(provider_from_registry(&state, &provider_id)?),
        BenchHarness::Rlm => None,
    };
    let model = ModelRef::new(&provider_id, &model_id);
    let corpus = BundledTasks::load().map_err(error_to_string)?;
    let selected = bench::tasks_for_tags(&corpus.tasks, &lesson.tags);
    if selected.is_empty() {
        return Err("no bench task to validate this lesson".into());
    }
    let _active = begin()?;
    let extra = format!(
        "<lesson_under_test>\n{}: {}\n</lesson_under_test>",
        lesson.title, lesson.content
    );
    let without = run_series(
        &app,
        &state,
        provider.as_ref(),
        &model,
        harness,
        &corpus,
        &selected,
        VALIDATION_REPETITIONS,
        None,
        "without",
    )
    .await;
    if let Some(error) = without.iter().find_map(|outcome| outcome.error.as_ref()) {
        return Err(format!("validation failed to run a task ({error}): the lesson keeps its status"));
    }
    let with = run_series(
        &app,
        &state,
        provider.as_ref(),
        &model,
        harness,
        &corpus,
        &selected,
        VALIDATION_REPETITIONS,
        Some(&extra),
        "with",
    )
    .await;
    let expected = selected.len() * VALIDATION_REPETITIONS as usize;
    if let Some(error) = with.iter().find_map(|outcome| outcome.error.as_ref()) {
        return Err(format!("validation failed to run a task ({error}): the lesson keeps its status"));
    }
    if stopped() || without.len() != expected || with.len() != expected {
        return Err("validation stopped: the lesson keeps its status".into());
    }
    let passed = |outcomes: &[TaskOutcome]| {
        outcomes
            .iter()
            .map(|outcome| outcome.passed)
            .collect::<Vec<_>>()
    };
    let (status, score_without, score_with) =
        bench::promotion_verdict(&passed(&without), &passed(&with));
    let current = find(&state)?;
    if current.title != lesson.title || current.content != lesson.content || current.tags != lesson.tags {
        return Err("lesson changed during validation: rerun the bench for its current text".into());
    }
    state
        .store
        .set_lesson_status(
            &lesson.id,
            status,
            Some(score_without),
            Some(score_with),
            expected as u32,
        )
        .map_err(error_to_string)?;
    find(&state)
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- Lot E1: lessons ---

#[tauri::command]
pub(super) fn list_lessons(state: State<'_, DesktopState>, status: Option<String>) -> Result<Vec<Lesson>, String> {
    state.store.list_lessons(status.as_deref()).map_err(error_to_string)
}

/// Editing a lesson sends it back to `candidate` and clears its scores.
#[tauri::command]
pub(super) fn update_lesson(state: State<'_, DesktopState>, id: String, title: String, content: String) -> Result<(), String> {
    state.store.update_lesson_text(&id, &title, &content).map_err(error_to_string)
}

#[tauri::command]
pub(super) fn delete_lesson(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    state.store.delete_lesson(&id).map_err(error_to_string)
}

#[tauri::command]
pub(super) fn clear_lessons(state: State<'_, DesktopState>) -> Result<(), String> {
    state.store.clear_lessons().map_err(error_to_string)
}

#[tauri::command]
pub(super) fn add_lesson(state: State<'_, DesktopState>, title: String, content: String, evidence: String) -> Result<Lesson, String> {
    state
        .store
        .insert_lesson(NewLesson { title, content, evidence, source_kind: "user".into(), ..Default::default() })
        .map_err(error_to_string)
}

/// Base lessons shipped with the app, added as candidates. Returns how many were new.
#[tauri::command]
pub(super) fn import_seed_lessons(state: State<'_, DesktopState>) -> Result<usize, String> {
    state.store.import_seed_lessons().map_err(error_to_string)
}

#[tauri::command]
pub(super) fn import_prime_memory(state: State<'_, DesktopState>, title: String, content: String) -> Result<Lesson, String> {
    state
        .store
        .insert_lesson(NewLesson {
            title,
            content,
            evidence: "imported from RLM memory".into(),
            source_kind: "prime_import".into(),
            ..Default::default()
        })
        .map_err(error_to_string)
}
