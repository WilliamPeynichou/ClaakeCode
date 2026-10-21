use std::collections::HashMap;

use eventsource_stream::Eventsource;
use futures::{stream::Stream, StreamExt};
use serde_json::{json, Value};

use claakecode_core::{
    AppError, PartKind, ProviderStream, StopReason, StreamEvent, ToolCallIntro, Usage,
};

use crate::wire::{ChatChunk, DeltaContent, DeltaContentBlock};

pub fn map_stream<S, E>(body: S, model: String) -> ProviderStream
where
    S: Stream<Item = std::result::Result<bytes::Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let source = Box::pin(body.eventsource());
    let parser = EventParser::new(model);

    futures::stream::unfold(
        (source, parser, Vec::<StreamEvent>::new(), false, false),
        |(mut source, mut parser, mut pending, done, mut saw_any_event)| async move {
            loop {
                if let Some(next) = pending.pop() {
                    return Some((Ok(next), (source, parser, pending, done, saw_any_event)));
                }
                if done {
                    return None;
                }

                match source.next().await {
                    Some(Ok(event)) => {
                        saw_any_event = true;
                        let data = event.data.trim();
                        if data.is_empty() {
                            continue;
                        }
                        if data == "[DONE]" {
                            let mut produced = parser.finish();
                            produced.reverse();
                            pending = produced;
                            if pending.is_empty() {
                                return None;
                            }
                            continue;
                        }

                        if let Ok(value) = serde_json::from_str::<Value>(data) {
                            if let Some(error) = value.get("error") {
                                let message = error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("mistral stream error");
                                return Some((
                                    Err(AppError::Provider(message.to_string())),
                                    (source, parser, pending, true, saw_any_event),
                                ));
                            }
                        }

                        let parsed: std::result::Result<ChatChunk, _> = serde_json::from_str(data);
                        match parsed {
                            Ok(parsed) => {
                                let mut produced = parser.push(parsed);
                                produced.reverse();
                                pending = produced;
                            }
                            Err(err) => {
                                return Some((
                                    Err(AppError::Decode(format!("bad mistral event: {err}"))),
                                    (source, parser, pending, true, saw_any_event),
                                ));
                            }
                        }
                    }
                    Some(Err(err)) => {
                        return Some((
                            Err(AppError::Stream(err.to_string())),
                            (source, parser, pending, true, saw_any_event),
                        ));
                    }
                    None => {
                        if !saw_any_event {
                            return Some((
                                Err(AppError::Stream(
                                    "mistral SSE closed before any event; \
                                     the server likely dropped the connection"
                                        .into(),
                                )),
                                (source, parser, pending, true, saw_any_event),
                            ));
                        }
                        let mut produced = parser.finish();
                        produced.reverse();
                        pending = produced;
                        if pending.is_empty() {
                            return None;
                        }
                    }
                }
            }
        },
    )
    .boxed()
}

#[derive(Debug, Default)]
struct ToolState {
    part_index: Option<usize>,
    id: String,
    name: String,
    pending_args: String,
}

struct EventParser {
    model: String,
    started: bool,
    next_index: usize,
    open_part: Option<(usize, PartKind)>,
    tool_states: HashMap<usize, ToolState>,
    saw_tool_call: bool,
    stop_reason: Option<StopReason>,
    usage: Usage,
    done: bool,
}

impl EventParser {
    fn new(model: String) -> Self {
        Self {
            model,
            started: false,
            next_index: 0,
            open_part: None,
            tool_states: HashMap::new(),
            saw_tool_call: false,
            stop_reason: None,
            usage: Usage::default(),
            done: false,
        }
    }

    fn push(&mut self, chunk: ChatChunk) -> Vec<StreamEvent> {
        if self.done {
            return Vec::new();
        }
        if let Some(model) = chunk.model.filter(|value| !value.trim().is_empty()) {
            self.model = model;
        }
        if let Some(usage) = chunk.usage {
            self.usage = usage_from_body(usage);
        }

        let mut out = Vec::new();
        for choice in chunk.choices {
            if let Some(content) = choice.delta.content {
                match content {
                    DeltaContent::Text(text) => self.push_text(text, PartKind::Text, &mut out),
                    DeltaContent::Blocks(blocks) => {
                        for block in blocks {
                            match block {
                                DeltaContentBlock::Text { text } => {
                                    self.push_text(text, PartKind::Text, &mut out);
                                }
                                DeltaContentBlock::Thinking { thinking } => {
                                    for fragment in thinking {
                                        self.push_text(fragment.text, PartKind::Thinking, &mut out);
                                    }
                                }
                                DeltaContentBlock::Other => {}
                            }
                        }
                    }
                }
            }
            for call in choice.delta.tool_calls {
                self.push_tool_delta(call, &mut out);
            }
            if let Some(reason) = choice.finish_reason {
                self.stop_reason = Some(map_stop_reason(&reason, self.saw_tool_call));
                out.extend(self.finish());
            }
        }

        out
    }

    fn push_text(&mut self, text: String, kind: PartKind, out: &mut Vec<StreamEvent>) {
        if text.is_empty() {
            return;
        }
        self.ensure_started(out);
        let index = self.ensure_open(kind, out);
        out.push(match kind {
            PartKind::Thinking => StreamEvent::ThinkingDelta { index, delta: text },
            _ => StreamEvent::TextDelta { index, delta: text },
        });
    }

    fn push_tool_delta(&mut self, call: crate::wire::ToolCallDelta, out: &mut Vec<StreamEvent>) {
        self.ensure_started(out);
        self.saw_tool_call = true;
        let key = call.index.unwrap_or(self.tool_states.len());
        let mut state = self.tool_states.remove(&key).unwrap_or_default();
        if let Some(id) = call.id.filter(|value| !value.trim().is_empty()) {
            state.id = id;
        }
        let mut new_args = String::new();
        if let Some(function) = call.function {
            if let Some(name) = function.name.filter(|value| !value.trim().is_empty()) {
                state.name = name;
            }
            if let Some(arguments) = function.arguments.filter(|value| !value.is_empty()) {
                new_args = arguments;
            }
        }

        if state.part_index.is_none() && !state.name.is_empty() {
            self.close_open(out);
            let part_index = self.next_index();
            let id = if state.id.is_empty() {
                format!("call_mistral_{key}")
            } else {
                state.id.clone()
            };
            state.id = id.clone();
            state.part_index = Some(part_index);
            out.push(StreamEvent::PartStart {
                index: part_index,
                kind: PartKind::ToolCall,
                tool: Some(ToolCallIntro {
                    id,
                    name: state.name.clone(),
                }),
            });
            if !state.pending_args.is_empty() {
                out.push(StreamEvent::ToolJsonDelta {
                    index: part_index,
                    chunk: std::mem::take(&mut state.pending_args),
                });
            }
        }

        if let Some(part_index) = state.part_index {
            if !new_args.is_empty() {
                out.push(StreamEvent::ToolJsonDelta {
                    index: part_index,
                    chunk: new_args,
                });
            }
        } else if !new_args.is_empty() {
            state.pending_args.push_str(&new_args);
        }

        self.tool_states.insert(key, state);
    }

    fn ensure_started(&mut self, out: &mut Vec<StreamEvent>) {
        if self.started {
            return;
        }
        self.started = true;
        out.push(StreamEvent::MessageStart {
            model: self.model.clone(),
        });
    }

    fn ensure_open(&mut self, kind: PartKind, out: &mut Vec<StreamEvent>) -> usize {
        if self.open_part.map(|(_, current)| current) == Some(kind) {
            return self.open_part.map(|(index, _)| index).unwrap_or(0);
        }
        self.close_open(out);
        let index = self.next_index();
        self.open_part = Some((index, kind));
        out.push(StreamEvent::PartStart {
            index,
            kind,
            tool: None,
        });
        index
    }

    fn close_open(&mut self, out: &mut Vec<StreamEvent>) {
        if let Some((index, _)) = self.open_part.take() {
            out.push(StreamEvent::PartStop { index });
        }
    }

    fn next_index(&mut self) -> usize {
        let index = self.next_index;
        self.next_index += 1;
        index
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        if self.done {
            return Vec::new();
        }
        self.done = true;
        let mut out = Vec::new();
        if !self.started {
            self.ensure_started(&mut out);
        }
        self.close_open(&mut out);
        let mut keys = self.tool_states.keys().copied().collect::<Vec<_>>();
        keys.sort_unstable();
        for key in keys {
            if let Some(state) = self.tool_states.remove(&key) {
                if let Some(index) = state.part_index {
                    out.push(StreamEvent::PartMeta {
                        index,
                        meta: json!({ "provider": "mistral", "id": state.id, "name": state.name }),
                    });
                    out.push(StreamEvent::PartStop { index });
                }
            }
        }
        out.push(StreamEvent::MessageStop {
            stop_reason: self.stop_reason.unwrap_or({
                if self.saw_tool_call {
                    StopReason::ToolUse
                } else {
                    StopReason::EndTurn
                }
            }),
            usage: self.usage,
        });
        out
    }
}

fn usage_from_body(body: crate::wire::UsageBody) -> Usage {
    Usage {
        input_tokens: body.prompt_tokens,
        output_tokens: body.completion_tokens,
        total_tokens: if body.total_tokens > 0 {
            body.total_tokens
        } else {
            body.prompt_tokens.saturating_add(body.completion_tokens)
        },
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
    }
}

fn map_stop_reason(raw: &str, saw_tool_call: bool) -> StopReason {
    match raw {
        "stop" => StopReason::EndTurn,
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" | "model_length" => StopReason::MaxTokens,
        "content_filter" => StopReason::Other,
        "error" => StopReason::Other,
        _ if saw_tool_call => StopReason::ToolUse,
        _ => StopReason::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(parser: &mut EventParser, value: Value) -> Vec<StreamEvent> {
        parser.push(serde_json::from_value(value).unwrap())
    }

    #[test]
    fn accepts_legacy_text_null_and_empty_content() {
        let mut parser = EventParser::new("codestral".into());
        for content in [Value::Null, json!(""), json!([])] {
            assert!(push(
                &mut parser,
                json!({"choices": [{"delta": {"content": content}}]})
            )
            .is_empty());
        }
        let events = push(
            &mut parser,
            json!({"choices": [{"delta": {"content": "Hello"}}]}),
        );
        assert!(
            matches!(&events[2], StreamEvent::TextDelta { index: 0, delta } if delta == "Hello")
        );
    }

    #[test]
    fn separates_thinking_and_text_in_order() {
        let mut parser = EventParser::new("mistral-large-4".into());
        let events = push(
            &mut parser,
            json!({"choices": [{"delta": {"content": [
            {"type": "thinking", "thinking": [{"type": "text", "text": "Let me "}, {"type": "text", "text": "think."}]},
            {"type": "text", "text": "Answer"},
            {"type": "citation", "id": "metadata"}
        ]}, "finish_reason": "stop"}]}),
        );
        assert!(matches!(
            &events[1],
            StreamEvent::PartStart {
                index: 0,
                kind: PartKind::Thinking,
                ..
            }
        ));
        assert!(
            matches!(&events[2], StreamEvent::ThinkingDelta { index: 0, delta } if delta == "Let me ")
        );
        assert!(
            matches!(&events[3], StreamEvent::ThinkingDelta { index: 0, delta } if delta == "think.")
        );
        assert!(matches!(&events[4], StreamEvent::PartStop { index: 0 }));
        assert!(matches!(
            &events[5],
            StreamEvent::PartStart {
                index: 1,
                kind: PartKind::Text,
                ..
            }
        ));
        assert!(
            matches!(&events[6], StreamEvent::TextDelta { index: 1, delta } if delta == "Answer")
        );
        assert!(matches!(
            events.last(),
            Some(StreamEvent::MessageStop {
                stop_reason: StopReason::EndTurn,
                ..
            })
        ));
        assert!(parser.finish().is_empty());
    }

    #[test]
    fn structured_content_preserves_tools_and_usage() {
        let mut parser = EventParser::new("mistral-large-4".into());
        let events = push(
            &mut parser,
            json!({
                "choices": [{"delta": {
                    "content": [{"type": "text", "text": "Searching"}],
                    "tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "search", "arguments": "{}"}}]
                }, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
            }),
        );
        assert!(events.iter().any(
            |event| matches!(event, StreamEvent::ToolJsonDelta { chunk, .. } if chunk == "{}")
        ));
        assert!(
            matches!(events.last(), Some(StreamEvent::MessageStop { stop_reason: StopReason::ToolUse, usage }) if usage.total_tokens == 30)
        );
    }

    #[test]
    fn malformed_known_content_is_not_silently_discarded() {
        assert!(
            serde_json::from_value::<ChatChunk>(json!({"choices": [{"delta": {
                "content": [{"type": "text", "text": 42}]
            }}]}))
            .is_err()
        );
    }
}
