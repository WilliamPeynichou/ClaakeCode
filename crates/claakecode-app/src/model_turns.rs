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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageBucketInput {
    pub start_at_ms: i64,
    pub end_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageBucket {
    pub start_at_ms: i64,
    pub end_at_ms: i64,
    pub turns: u64,
    pub usage_turns: u64,
    pub known_usage_turns: u64,
    pub unknown_usage_turns: u64,
    pub price_coverage_turns: u64,
    pub input_tokens: u64,
    pub prompt_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Estimated using the currently configured user price; absent unless all turns have usage and a price.
    pub estimated_cost: Option<f64>,
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
        self.measured_model_stats_in_range(since, None, harness)
    }

    /// Exact turn-start filtering in UTC epoch milliseconds: [since, until).
    /// Unlike legacy history, no conversation-level timestamp approximation is needed.
    pub fn measured_model_stats_in_range(&self, since: Option<i64>, until: Option<i64>, harness: Option<&str>) -> Result<Vec<MeasuredModelStats>> {
        anyhow::ensure!(!matches!((since, until), (Some(start), Some(end)) if start >= end), "start must be before end");
        use std::collections::BTreeMap;
        let conn = self.connection()?;
        let mut statement = conn.prepare("select record_json, rewritten from model_turns where started_at_ms >= ?1 and (?2 is null or started_at_ms < ?2) order by id")?;
        let records = statement.query_map(params![since.unwrap_or(i64::MIN), until], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)))?;
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
    /// Exact local measurements grouped into caller-provided UTC half-open calendar buckets.
    /// Legacy conversation history is intentionally excluded: its per-message timestamps are approximate.
    pub fn measured_model_usage_series(&self, buckets: &[ModelUsageBucketInput], harness: Option<&str>) -> Result<Vec<ModelUsageBucket>> {
        anyhow::ensure!(!buckets.is_empty() && buckets.len() <= 366, "bucket count must be between 1 and 366");
        for (i, b) in buckets.iter().enumerate() {
            anyhow::ensure!(b.start_at_ms < b.end_at_ms, "bucket start must be before end");
            if i > 0 {
                anyhow::ensure!(buckets[i - 1].end_at_ms == b.start_at_ms, "buckets must be contiguous and ordered");
            }
        }
        let conn = self.connection()?;
        let prices = self.model_prices()?;
        let mut out: Vec<ModelUsageBucket> = buckets.iter().map(|b| ModelUsageBucket {
            start_at_ms: b.start_at_ms, end_at_ms: b.end_at_ms, ..Default::default()
        }).collect();
        let mut statement = conn.prepare("select record_json from model_turns where started_at_ms >= ?1 and started_at_ms < ?2 order by started_at_ms, id")?;
        for (i, bucket) in buckets.iter().enumerate() {
            let records = statement.query_map(params![bucket.start_at_ms, bucket.end_at_ms], |row| row.get::<_, String>(0))?;
            let mut cost = 0.0;
            let mut all_usage_known = true;
            let mut matched_price = true;
            for json in records {
                let r: ModelTurn = serde_json::from_str(&json?)?;
                if harness.is_some_and(|h| h != r.harness) { continue; }
                let b = &mut out[i];
                b.turns += 1;
                let (Some(input), Some(prompt), Some(output), Some(cache_read), Some(cache_creation)) =
                    (r.input_tokens, r.prompt_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens) else {
                        b.unknown_usage_turns += 1;
                        all_usage_known = false;
                        continue;
                    };
                b.usage_turns += 1;
                b.known_usage_turns += 1;
                b.input_tokens = b.input_tokens.saturating_add(input);
                b.prompt_tokens = b.prompt_tokens.saturating_add(prompt);
                b.output_tokens = b.output_tokens.saturating_add(output);
                b.reasoning_tokens = b.reasoning_tokens.saturating_add(r.reasoning_tokens.unwrap_or(0));
                b.cache_read_tokens = b.cache_read_tokens.saturating_add(cache_read);
                b.cache_creation_tokens = b.cache_creation_tokens.saturating_add(cache_creation);
                if let Some(price) = prices.iter().find(|p| p.provider == r.provider && p.model == r.model) {
                    let uncached = prompt.saturating_sub(cache_read).saturating_sub(cache_creation);
                    cost += (uncached as f64 * price.input + output as f64 * price.output + cache_read as f64 * price.cache_read + cache_creation as f64 * price.cache_creation) / 1_000_000.0;
                    b.price_coverage_turns += 1;
                } else { matched_price = false; }
            }
            let b = &mut out[i];
            b.unknown_usage_turns = b.turns.saturating_sub(b.known_usage_turns);
            if b.turns == 0 { b.estimated_cost = Some(0.0); }
            else if all_usage_known && matched_price && b.price_coverage_turns == b.turns { b.estimated_cost = Some(cost); }
        }
        Ok(out)
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
    fn calendar_bounds_are_half_open_and_keep_leap_day() -> Result<()> {
        let store = AppStore::in_memory()?;
        // 2024-02-01, leap day, and 2024-03-01 at 00:00 UTC.
        let feb = 1_706_745_600_000;
        let leap = 1_709_164_800_000;
        let march = 1_709_251_200_000;
        for started_at_ms in [feb - 1, feb, leap, march - 1, march, i64::MAX] {
            store.record_model_turn(&ModelTurn {
                conversation_id: "calendar".into(), provider: "p".into(), model: "m".into(),
                harness: "classic".into(), started_at_ms, output_tokens: Some(7),
                ..Default::default()
            })?;
        }
        let rows = store.measured_model_stats_in_range(Some(feb), Some(march), None)?;
        assert_eq!(rows[0].turns, 3);
        assert_eq!(rows[0].output_tokens, 21);
        assert!(store.measured_model_stats_in_range(Some(feb), Some(march), Some("rlm"))?.is_empty());
        assert_eq!(store.measured_model_stats(Some(march), None)?[0].turns, 2);
        assert_eq!(store.measured_model_stats(None, None)?[0].turns, 6);
        assert!(store.measured_model_stats_in_range(Some(march), Some(feb), None).is_err());
        assert!(store.measured_model_stats_in_range(Some(feb), Some(feb), None).is_err());
        let _ = std::fs::remove_file(store.path());
        Ok(())
    }

    #[test]
    fn usage_series_exact_boundaries_coverage_prices_and_empty_buckets() -> Result<()> {
        let store = AppStore::in_memory()?;
        store.save_model_prices(&[ModelPrice { provider: "p".into(), model: "m".into(), input: 2., output: 4., cache_read: 0.5, cache_creation: 1. }])?;
        for (at, output) in [(99, Some(2)), (100, Some(3)), (199, Some(4)), (200, Some(5))] {
            store.record_model_turn(&ModelTurn { conversation_id: "c".into(), provider: "p".into(), model: "m".into(), harness: "classic".into(), started_at_ms: at, input_tokens: Some(10), prompt_tokens: Some(10), output_tokens: output, cache_read_tokens: Some(2), cache_creation_tokens: Some(1), ..Default::default() })?;
        }
        let rows = store.measured_model_usage_series(&[
            ModelUsageBucketInput { start_at_ms: 100, end_at_ms: 200 },
            ModelUsageBucketInput { start_at_ms: 200, end_at_ms: 300 },
        ], None)?;
        assert_eq!((rows[0].turns, rows[0].known_usage_turns, rows[0].output_tokens), (2, 2, 7));
        assert!((rows[0].estimated_cost.unwrap() - (14.0*2.0 + 7.0*4.0 + 4.0*0.5 + 2.0*1.0)/1_000_000.0).abs() < 1e-12);
        assert_eq!(rows[1].turns, 1);
        assert_eq!(rows[1].estimated_cost, Some((7.0*2.0 + 5.0*4.0 + 2.0*0.5 + 1.0)/1_000_000.0));
        let empty = store.measured_model_usage_series(&[ModelUsageBucketInput { start_at_ms: 300, end_at_ms: 400 }], None)?;
        assert_eq!(empty[0].estimated_cost, Some(0.0));
        assert!(store.measured_model_usage_series(&[
            ModelUsageBucketInput { start_at_ms: 0, end_at_ms: 10 },
            ModelUsageBucketInput { start_at_ms: 11, end_at_ms: 20 },
        ], None).is_err());
        Ok(())
    }

    #[test]
    fn usage_series_cost_is_unknown_for_incomplete_usage_or_missing_price() -> Result<()> {
        let store = AppStore::in_memory()?;
        store.record_model_turn(&ModelTurn { started_at_ms: 1, provider: "p".into(), model: "unknown".into(), output_tokens: Some(2), ..Default::default() })?;
        let rows = store.measured_model_usage_series(&[ModelUsageBucketInput { start_at_ms: 0, end_at_ms: 2 }], None)?;
        assert_eq!(rows[0].unknown_usage_turns, 1);
        assert_eq!(rows[0].estimated_cost, None);
        assert_eq!(rows[0].price_coverage_turns, 0);
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
