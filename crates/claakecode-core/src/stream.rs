use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::AppError,
    message::{StopReason, Usage},
};

pub type ProviderStream = BoxStream<'static, Result<StreamEvent, AppError>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartKind {
    Text,
    Thinking,
    ToolCall,
}

#[derive(Debug, Clone)]
pub struct ToolCallIntro {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    MessageStart {
        model: String,
    },
    PartStart {
        index: usize,
        kind: PartKind,
        tool: Option<ToolCallIntro>,
    },
    TextDelta {
        index: usize,
        delta: String,
    },
    ThinkingDelta {
        index: usize,
        delta: String,
    },
    ToolJsonDelta {
        index: usize,
        chunk: String,
    },
    PartMeta {
        index: usize,
        meta: Value,
    },
    PartStop {
        index: usize,
    },
    Usage {
        usage: Usage,
    },
    MessageStop {
        stop_reason: StopReason,
        usage: Usage,
    },
    /// Provider response metadata; consumed by the app and not surfaced as content.
    QuotaObservation {
        observation: ProviderQuotaObservation,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaObservation {
    pub requests_remaining: Option<String>,
    pub requests_limit: Option<String>,
    pub requests_reset: Option<String>,
    pub input_tokens_remaining: Option<String>,
    pub input_tokens_limit: Option<String>,
    pub input_tokens_reset: Option<String>,
    pub output_tokens_remaining: Option<String>,
    pub output_tokens_limit: Option<String>,
    pub output_tokens_reset: Option<String>,
    pub observed_at: String,
}
