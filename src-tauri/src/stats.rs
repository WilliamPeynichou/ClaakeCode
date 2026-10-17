//! Tauri commands for the « Performance des modèles » settings page (benchmark B1/B3).
//! Local data only: aggregation runs on a blocking thread, never on the UI thread.
use crate::*;
use claakecode_app::{model_stats_csv, ModelStatsReport};
use claakecode_app::model_turns::{ModelPrice, ModelUsageBucket, ModelUsageBucketInput};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelStatsInput {
    /// `None` = all history.
    #[serde(default)]
    period_days: Option<u32>,
    /// Explicit UTC epoch-millisecond bounds, inclusive start and exclusive end.
    /// Both must be supplied together; they take precedence over `period_days`.
    #[serde(default)]
    start_at_ms: Option<i64>,
    #[serde(default)]
    end_at_ms: Option<i64>,
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

fn time_bounds(input: &ModelStatsInput) -> std::result::Result<(Option<i64>, Option<i64>), String> {
    match (input.start_at_ms, input.end_at_ms) {
        (Some(start), Some(end)) if start < end => Ok((Some(start), Some(end))),
        (Some(_), Some(_)) => Err("startAtMs must be before endAtMs".into()),
        (None, None) => Ok((since_ms(input.period_days), None)),
        _ => Err("startAtMs and endAtMs must be provided together".into()),
    }
}

fn harness_filter(harness: Option<String>) -> std::result::Result<Option<String>, String> {
    match harness.as_deref() {
        None | Some("") | Some("all") => Ok(None),
        Some("classic") | Some("rlm") => Ok(harness),
        Some(other) => Err(format!("unknown harness: {other}")),
    }
}

async fn compute(store: AppStore, input: ModelStatsInput) -> std::result::Result<ModelStatsReport, String> {
    let (since, until) = time_bounds(&input)?;
    let harness = harness_filter(input.harness)?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<ModelStatsReport> {
        let mut report = store.model_stats_in_range(since, until, harness.as_deref())?;
        report.measured = store.measured_model_stats_in_range(since, until, harness.as_deref())?;
        report.prices = store.model_prices()?;
        Ok(report)
    })
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
    tokio::task::spawn_blocking(move || fs::write(&path, model_stats_csv(&report)))
        .await.map_err(error_to_string)?.map_err(error_to_string)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelUsageSeriesInput {
    buckets: Vec<ModelUsageBucketInput>,
    #[serde(default)]
    harness: Option<String>,
}

#[tauri::command]
pub(super) async fn get_model_usage_series(
    state: State<'_, DesktopState>,
    input: ModelUsageSeriesInput,
) -> std::result::Result<Vec<ModelUsageBucket>, String> {
    let harness = harness_filter(input.harness)?;
    let buckets = input.buckets;
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.measured_model_usage_series(&buckets, harness.as_deref()))
        .await.map_err(error_to_string)?.map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn clear_model_stats(state: State<'_, DesktopState>) -> std::result::Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.clear_model_stats()).await.map_err(error_to_string)?.map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn save_model_prices(state: State<'_, DesktopState>, prices: Vec<ModelPrice>) -> std::result::Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.save_model_prices(&prices)).await.map_err(error_to_string)?.map_err(error_to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_bounds_override_legacy_days_and_validate_pair() {
        let input: ModelStatsInput = serde_json::from_str(
            r#"{"periodDays":7,"startAtMs":100,"endAtMs":200}"#,
        ).unwrap();
        assert_eq!(time_bounds(&input).unwrap(), (Some(100), Some(200)));
        for json in [
            r#"{"startAtMs":100}"#, r#"{"endAtMs":200}"#,
            r#"{"startAtMs":200,"endAtMs":200}"#,
            r#"{"startAtMs":300,"endAtMs":200}"#,
        ] {
            assert!(time_bounds(&serde_json::from_str(json).unwrap()).is_err(), "{json}");
        }
        assert_eq!(time_bounds(&ModelStatsInput::default()).unwrap(), (None, None));
        let legacy: ModelStatsInput = serde_json::from_str(r#"{"periodDays":7}"#).unwrap();
        let (start, end) = time_bounds(&legacy).unwrap();
        assert!(start.is_some());
        assert_eq!(end, None);
    }
}
