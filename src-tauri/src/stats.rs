//! Tauri commands for the « Performance des modèles » settings page (benchmark B1/B3).
//! Local data only: aggregation runs on a blocking thread, never on the UI thread.
use crate::*;
use claakecode_app::{model_stats_csv, ModelStatsReport};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelStatsInput {
    /// `None` = all history.
    #[serde(default)]
    period_days: Option<u32>,
    /// "classic" | "rlm" | `None` for both.
    #[serde(default)]
    harness: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExportModelStatsInput {
    #[serde(flatten)]
    filter: ModelStatsInput,
    path: String,
}

fn since_ms(period_days: Option<u32>) -> Option<i64> {
    let days = period_days.filter(|d| *d > 0)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(now - i64::from(days) * DAY_MS)
}

fn harness_filter(harness: Option<String>) -> std::result::Result<Option<String>, String> {
    match harness.as_deref() {
        None | Some("") | Some("all") => Ok(None),
        Some("classic") | Some("rlm") => Ok(harness),
        Some(other) => Err(format!("unknown harness: {other}")),
    }
}

async fn compute(store: AppStore, input: ModelStatsInput) -> std::result::Result<ModelStatsReport, String> {
    let harness = harness_filter(input.harness)?;
    let since = since_ms(input.period_days);
    tokio::task::spawn_blocking(move || store.model_stats(since, harness.as_deref()))
        .await
        .map_err(|err| err.to_string())?
        .map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn get_model_stats(
    state: State<'_, DesktopState>,
    input: Option<ModelStatsInput>,
) -> std::result::Result<ModelStatsReport, String> {
    compute(state.store.clone(), input.unwrap_or_default()).await
}

/// Writes the CSV to a path picked by the user in the native save dialog.
#[tauri::command]
pub(super) async fn export_model_stats_csv(
    state: State<'_, DesktopState>,
    input: ExportModelStatsInput,
) -> std::result::Result<(), String> {
    let path = PathBuf::from(input.path.trim());
    if !path.is_absolute() {
        return Err("export path must be absolute".into());
    }
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("csv")) != Some(true) {
        return Err("export file must end with .csv".into());
    }
    let report = compute(state.store.clone(), input.filter).await?;
    fs::write(&path, model_stats_csv(&report)).map_err(|err| format!("unable to write CSV: {err}"))
}
