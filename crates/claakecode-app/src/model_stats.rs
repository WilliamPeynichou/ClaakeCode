//! Model performance stats computed from real usage (benchmark B1, `docs/plansNouvellesFeatures.md`).
//!
//! Source: the `meta.token_usage` that every assistant message already carries in
//! `messages.message_json`, so the existing history counts without any migration. One assistant
//! message = one model response (a single user turn can trigger several when tools run).
//! Only counters are produced: no prompt or answer text leaves this module.

use std::collections::{BTreeMap, HashMap};

use claakecode_core::{ChatMessage, Part, Role};
use serde::Serialize;
use serde_json::Value;

/// Below this many responses a row is flagged as not reliable.
pub const MODEL_STATS_MIN_RELIABLE: u64 = 20;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatsRow {
    pub harness: String,
    pub provider: String,
    pub model: String,
    /// Assistant responses carrying token usage.
    pub responses: u64,
    pub conversations: u64,
    pub input_tokens: u64,
    /// Whole prompt including cache, comparable across providers (Anthropic's `input_tokens`
    /// excludes cached tokens, OpenAI's includes them): `total - output` when total is known.
    pub prompt_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub tool_calls: u64,
    pub tool_errors: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatsReport {
    pub rows: Vec<ModelStatsRow>,
    pub total_responses: u64,
    pub min_reliable: u64,
    /// Lower bound of the period (ms since epoch), `None` = all history.
    pub since_ms: Option<i64>,
    pub measured: Vec<crate::model_turns::MeasuredModelStats>,
    pub prices: Vec<crate::model_turns::ModelPrice>,
}

/// Accumulates conversations one by one; call [`ModelStatsAccumulator::finish`] at the end.
#[derive(Default)]
pub struct ModelStatsAccumulator {
    rows: BTreeMap<(String, String, String), ModelStatsRow>,
    conversation_seen: HashMap<(String, String, String), String>,
}

impl ModelStatsAccumulator {
    /// `messages` must be in ordinal order. Unparseable messages are ignored.
    pub fn add_conversation(&mut self, conversation_id: &str, harness: &str, messages: &[ChatMessage]) {
        // tool_call_id -> row key, to blame a failed tool result on the model that asked for it.
        let mut call_owner: HashMap<&str, (String, String, String)> = HashMap::new();
        for message in messages {
            match message.role {
                Role::Assistant => {
                    let Some((provider, model, usage)) = token_usage(message) else {
                        continue;
                    };
                    let key = (harness.to_string(), provider, model);
                    let row = self.rows.entry(key.clone()).or_insert_with(|| ModelStatsRow {
                        harness: key.0.clone(),
                        provider: key.1.clone(),
                        model: key.2.clone(),
                        ..Default::default()
                    });
                    row.responses += 1;
                    let (input, output, total) =
                        (num(usage, "input_tokens"), num(usage, "output_tokens"), num(usage, "total_tokens"));
                    row.input_tokens += input;
                    row.prompt_tokens += if total > output { total - output } else { input };
                    row.output_tokens += output;
                    row.reasoning_tokens += num(usage, "reasoning_tokens");
                    row.cache_read_tokens += num(usage, "cache_read_tokens");
                    row.cache_creation_tokens += num(usage, "cache_creation_tokens");
                    if self.conversation_seen.get(&key).map(String::as_str) != Some(conversation_id) {
                        row.conversations += 1;
                        self.conversation_seen.insert(key.clone(), conversation_id.to_string());
                    }
                    for part in &message.parts {
                        if let Part::ToolCall { id, .. } = part {
                            row.tool_calls += 1;
                            call_owner.insert(id.as_str(), key.clone());
                        }
                    }
                }
                Role::User => {
                    for part in &message.parts {
                        if let Part::ToolResult { tool_call_id, is_error: true, .. } = part {
                            if let Some(row) = call_owner
                                .get(tool_call_id.as_str())
                                .and_then(|key| self.rows.get_mut(key))
                            {
                                row.tool_errors += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn finish(self, since_ms: Option<i64>) -> ModelStatsReport {
        let mut rows: Vec<ModelStatsRow> = self.rows.into_values().collect();
        rows.sort_by(|a, b| b.responses.cmp(&a.responses).then_with(|| a.model.cmp(&b.model)));
        ModelStatsReport {
            total_responses: rows.iter().map(|row| row.responses).sum(),
            rows,
            min_reliable: MODEL_STATS_MIN_RELIABLE,
            since_ms,
            measured: vec![],
            prices: vec![],
        }
    }
}

/// `(provider, model, usage)` from the first part carrying `meta.token_usage`.
fn token_usage(message: &ChatMessage) -> Option<(String, String, &Value)> {
    message.parts.iter().find_map(|part| {
        let usage = part_meta(part)?.get("token_usage")?;
        let model = usage.get("model")?.as_str()?.trim();
        if model.is_empty() {
            return None;
        }
        let provider = usage.get("provider").and_then(Value::as_str).unwrap_or("unknown").trim();
        Some((provider.to_string(), model.to_string(), usage))
    })
}

fn part_meta(part: &Part) -> Option<&Value> {
    match part {
        Part::Text { meta, .. }
        | Part::Image { meta, .. }
        | Part::Thinking { meta, .. }
        | Part::ToolCall { meta, .. }
        | Part::ToolResult { meta, .. } => meta.as_ref(),
    }
}

fn num(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// CSV export (RFC 4180 quoting). Ratios are left to the reader: raw counters only.
pub fn model_stats_csv(report: &ModelStatsReport) -> String {
    let mut out = String::from(
        "harness,provider,model,responses,conversations,input_tokens,prompt_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_creation_tokens,tool_calls,tool_errors\n",
    );
    for row in &report.rows {
        let fields = [
            csv_field(&row.harness),
            csv_field(&row.provider),
            csv_field(&row.model),
            row.responses.to_string(),
            row.conversations.to_string(),
            row.input_tokens.to_string(),
            row.prompt_tokens.to_string(),
            row.output_tokens.to_string(),
            row.reasoning_tokens.to_string(),
            row.cache_read_tokens.to_string(),
            row.cache_creation_tokens.to_string(),
            row.tool_calls.to_string(),
            row.tool_errors.to_string(),
        ];
        out.push_str(&fields.join(","));
        out.push('\n');
    }
    out.push_str("\nmeasured_harness,provider,model,subagent,turns,usage_turns,errors,interrupted,rewrites,median_duration_ms,median_first_token_ms,median_tokens_per_second,speed_samples\n");
    for r in &report.measured {
        out.push_str(&[
            csv_field(&r.harness), csv_field(&r.provider), csv_field(&r.model), r.is_subagent.to_string(),
            r.turns.to_string(), r.usage_turns.to_string(), r.errors.to_string(), r.interrupted.to_string(), r.rewrites.to_string(),
            r.median_duration_ms.map(|v| v.to_string()).unwrap_or_default(),
            r.median_first_token_ms.map(|v| v.to_string()).unwrap_or_default(),
            r.median_tokens_per_second.map(|v| v.to_string()).unwrap_or_default(), r.speed_samples.to_string(),
        ].join(","));
        out.push('\n');
    }
    out
}

fn csv_field(value: &str) -> String {
    // A leading = + - @ would be run as a formula by spreadsheets.
    let value = if value.starts_with(['=', '+', '-', '@']) {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assistant(provider: &str, model: &str, input: u64, output: u64, cache: u64, calls: &[&str]) -> ChatMessage {
        let mut parts = vec![Part::Text {
            text: "réponse".into(),
            meta: Some(json!({ "token_usage": {
                "source": "stream", "provider": provider, "model": model,
                "input_tokens": input, "output_tokens": output, "total_tokens": input + output,
                "reasoning_tokens": 5, "cache_read_tokens": cache, "cache_creation_tokens": 1
            }})),
        }];
        for id in calls {
            parts.push(Part::ToolCall { id: (*id).into(), name: "read".into(), input: json!({}), meta: None });
        }
        ChatMessage { role: Role::Assistant, parts }
    }

    fn tool_result(id: &str, is_error: bool) -> ChatMessage {
        ChatMessage {
            role: Role::User,
            parts: vec![Part::ToolResult {
                tool_call_id: id.into(),
                content: "x".into(),
                images: vec![],
                is_error,
                meta: None,
            }],
        }
    }

    #[test]
    fn aggregates_by_harness_provider_model() {
        let mut acc = ModelStatsAccumulator::default();
        acc.add_conversation(
            "c1",
            "classic",
            &[
                ChatMessage::user_text("salut"),
                assistant("anthropic", "opus", 100, 20, 50, &["t1", "t2"]),
                tool_result("t1", false),
                tool_result("t2", true),
                assistant("anthropic", "opus", 200, 30, 150, &[]),
                assistant("openai", "gpt", 10, 1, 0, &[]),
                // No usage: ignored.
                ChatMessage::assistant_text("sans usage"),
            ],
        );
        acc.add_conversation("c2", "classic", &[assistant("anthropic", "opus", 1, 1, 0, &[])]);
        acc.add_conversation("c3", "rlm", &[assistant("anthropic", "opus", 1, 1, 0, &[])]);
        let report = acc.finish(Some(42));

        assert_eq!(report.total_responses, 5);
        assert_eq!(report.since_ms, Some(42));
        assert_eq!(report.rows.len(), 3);
        let opus = &report.rows[0];
        assert_eq!((opus.harness.as_str(), opus.model.as_str()), ("classic", "opus"));
        assert_eq!(opus.responses, 3);
        assert_eq!(opus.conversations, 2);
        assert_eq!(opus.input_tokens, 301);
        // total = input + output in the fixture, so prompt == input; without total, falls back.
        assert_eq!(opus.prompt_tokens, 301);
        assert_eq!(opus.output_tokens, 51);
        assert_eq!(opus.reasoning_tokens, 15);
        assert_eq!(opus.cache_read_tokens, 200);
        assert_eq!(opus.tool_calls, 2);
        assert_eq!(opus.tool_errors, 1);
        assert!(report.rows.iter().any(|r| r.harness == "rlm" && r.responses == 1));
        assert!(report.rows.iter().any(|r| r.model == "gpt" && r.tool_errors == 0));
    }

    #[test]
    fn prompt_tokens_include_cache_when_input_excludes_it() {
        // Anthropic shape: input 10 excludes 90 cached, total = 10 + 90 + 5 output.
        let message = ChatMessage {
            role: Role::Assistant,
            parts: vec![Part::Text {
                text: String::new(),
                meta: Some(json!({ "token_usage": {
                    "provider": "anthropic", "model": "opus", "input_tokens": 10,
                    "output_tokens": 5, "total_tokens": 105, "cache_read_tokens": 90
                }})),
            }],
        };
        let mut acc = ModelStatsAccumulator::default();
        acc.add_conversation("c", "classic", &[message]);
        let row = &acc.finish(None).rows[0];
        assert_eq!((row.input_tokens, row.prompt_tokens, row.cache_read_tokens), (10, 100, 90));
    }

    #[test]
    fn csv_quotes_and_neutralises_formulas() {
        let report = ModelStatsReport {
            rows: vec![ModelStatsRow {
                harness: "classic".into(),
                provider: "open,router".into(),
                model: "=cmd".into(),
                responses: 2,
                ..Default::default()
            }],
            ..Default::default()
        };
        let csv = model_stats_csv(&report);
        let line = csv.lines().nth(1).unwrap();
        assert!(line.starts_with("classic,\"open,router\",'=cmd,2,"), "{line}");
    }
}
