//! Local, content-free turn measurements. Unknown usage stays `None` (not measured zero).
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use claakecode_core::Usage;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTurn {
    pub conversation_id: String,
    pub provider: String,
    pub model: String,
    pub harness: String,
    pub is_subagent: bool,
    pub history_index: Option<usize>,
    pub started_at_ms: i64,
    pub duration_ms: i64,
    pub first_token_ms: Option<i64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub responses: u64,
    pub tool_calls: u64,
    pub tool_errors: u64,
    pub status: String,
}

pub struct TurnMeasurement {
    start: Instant,
    pub record: ModelTurn,
}

impl TurnMeasurement {
    pub fn new(conversation_id: String, provider: String, model: String, harness: &str, is_subagent: bool, history_index: Option<usize>) -> Self {
        Self { start: Instant::now(), record: ModelTurn {
            conversation_id, provider, model, harness: harness.into(), is_subagent, history_index,
            started_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64,
            status: "ok".into(), ..Default::default()
        }}
    }
    pub fn first_token(&mut self) {
        if self.record.first_token_ms.is_none() {
            self.record.first_token_ms = Some(self.start.elapsed().as_millis() as i64);
        }
    }
    pub fn usage(&mut self, usage: Usage) {
        let r = &mut self.record;
        fn add(slot: &mut Option<u64>, value: u32) { *slot = Some(slot.unwrap_or(0).saturating_add(u64::from(value))); }
        add(&mut r.input_tokens, usage.input_tokens);
        add(&mut r.output_tokens, usage.output_tokens);
        add(&mut r.prompt_tokens, usage.total_tokens.checked_sub(usage.output_tokens).filter(|n| *n > 0).unwrap_or(usage.input_tokens));
        add(&mut r.reasoning_tokens, usage.reasoning_tokens);
        add(&mut r.cache_read_tokens, usage.cache_read_tokens);
        add(&mut r.cache_creation_tokens, usage.cache_creation_tokens);
        r.responses += 1;
    }
    pub fn finish(mut self) -> ModelTurn {
        self.record.duration_ms = self.start.elapsed().as_millis() as i64;
        self.record
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredModelStats {
    pub provider: String,
    pub model: String,
    pub harness: String,
    pub is_subagent: bool,
    pub turns: u64,
    pub usage_turns: u64,
    pub errors: u64,
    pub interrupted: u64,
    pub rewrites: u64,
    pub median_duration_ms: Option<f64>,
    pub median_first_token_ms: Option<f64>,
    /// Whole-turn throughput, including tool/network/wait time, not pure generation speed.
    pub median_tokens_per_second: Option<f64>,
    pub speed_samples: u64,
    pub input_tokens: u64,
    pub prompt_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub tool_calls: u64,
    pub tool_errors: u64,
}

pub fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() { return None; }
    values.sort_by(f64::total_cmp);
    let n = values.len();
    Some(if n % 2 == 0 { (values[n / 2 - 1] + values[n / 2]) / 2.0 } else { values[n / 2] })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub provider: String,
    pub model: String,
    /// All rates in the same user-chosen currency, per million tokens. No bundled rates.
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
}

use crate::store::AppStore;
use anyhow::Result;
use rusqlite::params;

impl AppStore {
    pub fn record_model_turn(&self, record: &ModelTurn) -> Result<()> {
        self.connection()?.execute(
            "insert into model_turns(conversation_id, started_at_ms, history_index, record_json) values (?1, ?2, ?3, ?4)",
            params![record.conversation_id, record.started_at_ms, record.history_index.map(|n| n as i64), serde_json::to_string(record)?],
        )?;
        Ok(())
    }
    pub fn mark_model_turns_rewritten(&self, conversation_id: &str, history_index: usize) -> Result<()> {
        self.connection()?.execute("update model_turns set rewritten = 1 where conversation_id = ?1 and history_index >= ?2", params![conversation_id, history_index as i64])?;
        Ok(())
    }
    /// Does not alter chats. The legacy aggregate stays hidden after clearing, so old history
    /// cannot reappear on the next refresh; new measurements still accumulate.
    pub fn clear_model_stats(&self) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute("delete from model_turns", [])?;
        tx.execute("insert into app_settings(key, value_json, updated_at_ms) values ('model_stats_legacy_cleared', 'true', 0) on conflict(key) do update set value_json = 'true'", [])?;
        tx.commit()?;
        Ok(())
    }
    pub fn measured_model_stats(&self, since: Option<i64>, harness: Option<&str>) -> Result<Vec<MeasuredModelStats>> {
        use std::collections::BTreeMap;
        let conn = self.connection()?;
        let mut statement = conn.prepare("select record_json, rewritten from model_turns where started_at_ms >= ?1 order by id")?;
        let records = statement.query_map([since.unwrap_or(i64::MIN)], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)))?;
        let mut groups: BTreeMap<(String, String, String, bool), (MeasuredModelStats, Vec<f64>, Vec<f64>, Vec<f64>)> = BTreeMap::new();
        for record in records {
            let (json, rewritten) = record?;
            let r: ModelTurn = serde_json::from_str(&json)?;
            if harness.is_some_and(|h| h != r.harness) { continue; }
            let key = (r.provider.clone(), r.model.clone(), r.harness.clone(), r.is_subagent);
            let (s, durations, firsts, speeds) = groups.entry(key).or_insert_with(|| (MeasuredModelStats {
                provider: r.provider.clone(), model: r.model.clone(), harness: r.harness.clone(), is_subagent: r.is_subagent,
                ..Default::default()
            }, vec![], vec![], vec![]));
            s.turns += 1;
            s.errors += u64::from(r.status == "error");
            s.interrupted += u64::from(r.status == "interrupted");
            s.rewrites += u64::from(rewritten);
            s.usage_turns += u64::from(r.output_tokens.is_some());
            s.input_tokens += r.input_tokens.unwrap_or(0);
            s.prompt_tokens += r.prompt_tokens.unwrap_or(0);
            s.output_tokens += r.output_tokens.unwrap_or(0);
            s.reasoning_tokens += r.reasoning_tokens.unwrap_or(0);
            s.cache_read_tokens += r.cache_read_tokens.unwrap_or(0);
            s.cache_creation_tokens += r.cache_creation_tokens.unwrap_or(0);
            s.tool_calls += r.tool_calls;
            s.tool_errors += r.tool_errors;
            durations.push(r.duration_ms as f64);
            if let Some(ms) = r.first_token_ms { firsts.push(ms as f64); }
            if r.status == "ok" && r.duration_ms > 0 {
                if let Some(output) = r.output_tokens.filter(|n| *n > 0) { speeds.push(output as f64 * 1000.0 / r.duration_ms as f64); }
            }
        }
        Ok(groups.into_values().map(|(mut s, mut d, mut f, mut v)| {
            s.median_duration_ms = median(&mut d);
            s.median_first_token_ms = median(&mut f);
            s.speed_samples = v.len() as u64;
            s.median_tokens_per_second = median(&mut v);
            s
        }).collect())
    }
    pub fn model_prices(&self) -> Result<Vec<ModelPrice>> { Ok(self.load_json_setting("model_prices")?.unwrap_or_default()) }
    pub fn save_model_prices(&self, prices: &[ModelPrice]) -> Result<()> {
        let mut seen = std::collections::HashSet::new();
        for p in prices {
            anyhow::ensure!(!p.provider.trim().is_empty() && !p.model.trim().is_empty(), "provider and model required");
            anyhow::ensure!(seen.insert((&p.provider, &p.model)), "duplicate price entry");
            anyhow::ensure!([p.input, p.output, p.cache_read, p.cache_creation].iter().all(|v| v.is_finite() && *v >= 0.0), "prices must be finite and non-negative");
        }
        self.save_json_setting("model_prices", &prices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn store_measurements_clear_rewrite_and_prices() -> Result<()> {
        let store = AppStore::in_memory()?;
        let mut r = ModelTurn { conversation_id: "c".into(), provider: "p".into(), model: "m".into(), harness: "classic".into(), started_at_ms: 123, history_index: Some(2), duration_ms: 1000, output_tokens: Some(10), status: "ok".into(), ..Default::default() };
        store.record_model_turn(&r)?;
        r.is_subagent = true;
        store.record_model_turn(&r)?;
        store.mark_model_turns_rewritten("c", 2)?;
        let stats = store.measured_model_stats(None, None)?;
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].rewrites, 1);
        assert_eq!(stats[0].median_tokens_per_second, Some(10.));
        assert!(store.measured_model_stats(Some(124), None)?.is_empty());
        assert!(store.measured_model_stats(None, Some("rlm"))?.is_empty());
        store.clear_model_stats()?;
        assert!(store.measured_model_stats(None, None)?.is_empty());
        assert!(store.model_stats(None, None)?.rows.is_empty());
        store.record_model_turn(&r)?;
        assert_eq!(store.measured_model_stats(None, None)?.len(), 1);
        let price = ModelPrice { provider: "p".into(), model: "m".into(), input: 1., output: 2., cache_read: 0., cache_creation: 0. };
        store.save_model_prices(&[price])?;
        assert_eq!(store.model_prices()?.len(), 1);
        let invalid = ModelPrice { provider: "p".into(), model: "m".into(), input: -1., output: 0., cache_read: 0., cache_creation: 0. };
        assert!(store.save_model_prices(&[invalid]).is_err());
        let _ = std::fs::remove_file(store.path());
        Ok(())
    }
    #[test]
    fn unknown_usage_and_median() {
        let r = TurnMeasurement::new("c".into(), "p".into(), "m".into(), "rlm", false, None).finish();
        assert_eq!(r.output_tokens, None);
        assert_eq!(median(&mut []), None);
        assert_eq!(median(&mut [3., 1., 2., 4.]), Some(2.5));
    }
    #[test]
    fn cumulative_usage_counted_once_per_response() {
        let mut t = TurnMeasurement::new("c".into(), "p".into(), "m".into(), "classic", true, None);
        t.usage(Usage { input_tokens: 10, output_tokens: 5, total_tokens: 105, cache_read_tokens: 90, ..Default::default() });
        t.usage(Usage { input_tokens: 20, output_tokens: 10, total_tokens: 30, ..Default::default() });
        t.first_token(); t.first_token();
        let r = t.finish();
        assert_eq!(r.prompt_tokens, Some(120));
        assert_eq!(r.output_tokens, Some(15));
        assert_eq!(r.responses, 2);
        assert!(r.first_token_ms.is_some());
    }
}
