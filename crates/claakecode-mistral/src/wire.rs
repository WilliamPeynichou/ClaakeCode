use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct ChatCompletionsRequest<'a> {
    pub model: &'a str,
    pub messages: Vec<WireMessage<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<WireTool<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    pub stream: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum WireMessage<'a> {
    System {
        role: &'static str,
        content: WireContent,
    },
    User {
        role: &'static str,
        content: WireContent,
    },
    Assistant {
        role: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<WireContent>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<WireToolCall<'a>>,
    },
    Tool {
        role: &'static str,
        content: WireContent,
        tool_call_id: &'a str,
    },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum WireContent {
    Text(String),
    Blocks(Vec<WireContentBlock>),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireContentBlock {
    Text { text: String },
    ImageUrl { image_url: WireImageUrl },
}

#[derive(Debug, Serialize)]
pub struct WireImageUrl {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct WireToolCall<'a> {
    pub id: &'a str,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: WireToolCallFunction<'a>,
}

#[derive(Debug, Serialize)]
pub struct WireToolCallFunction<'a> {
    pub name: &'a str,
    pub arguments: String,
}

#[derive(Debug, Serialize)]
pub struct WireTool<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: WireToolFunction<'a>,
}

#[derive(Debug, Serialize)]
pub struct WireToolFunction<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub parameters: &'a Value,
}

#[derive(Debug, Deserialize)]
pub struct ChatChunk {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub choices: Vec<ChatChoice>,
    #[serde(default)]
    pub usage: Option<UsageBody>,
}

#[derive(Debug, Deserialize)]
pub struct ChatChoice {
    #[serde(default)]
    pub delta: ChatDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ChatDelta {
    #[serde(default)]
    pub content: Option<DeltaContent>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallDelta>,
}

/// Mistral may stream plain text or structured text/thinking fragments.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum DeltaContent {
    Text(String),
    Blocks(Vec<DeltaContentBlock>),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeltaContentBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: Vec<ThinkingText>,
    },
    // Metadata and future non-text fragments are not answer text.
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct ThinkingText {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct ToolCallDelta {
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<ToolCallFunctionDelta>,
}

#[derive(Debug, Deserialize)]
pub struct ToolCallFunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct UsageBody {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApiErrorEnvelope {
    #[serde(default)]
    pub error: ApiErrorBody,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub message: String,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}
