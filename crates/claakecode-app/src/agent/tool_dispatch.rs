use std::{collections::HashMap, sync::Arc};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::{
    tool_names, BashTool, CreateImageTool, DatabaseTool, EditFileTool, GlobTool, GrepTool,
    McpToolRegistry, PythonTool, QuestionTool, ReadFingerprint, ReadTool, SkillTool, SubAgentTool,
    TeamTool, ToDoListTool, TodoListState, ToolRunResult, ToolSettings, WebFetchTool,
    WebSearchTool, WriteFileTool,
};

use super::{cancel::TurnCancel, context::AgentMode, events::AgentEvent};

pub(super) fn should_wait_for_cooperative_cancel(
    name: &str,
    subagents: Option<&Arc<SubAgentTool>>,
    teams: Option<&Arc<TeamTool>>,
) -> bool {
    name.starts_with("subagent_")
        || teams
            .and_then(|tool| tool.summary_for_tool_name(name))
            .is_some()
        || subagents
            .and_then(|tool| tool.summary_for_tool_name(name))
            .is_some()
}

pub(super) async fn run_tool(
    bash: &BashTool,
    python: &PythonTool,
    glob: &GlobTool,
    grep: &GrepTool,
    read: &ReadTool,
    edit_file: &EditFileTool,
    write_file: &WriteFileTool,
    create_image: &CreateImageTool,
    todo_list_tool: Option<&ToDoListTool>,
    question: Option<&QuestionTool>,
    web_search: &WebSearchTool,
    web_fetch: &WebFetchTool,
    skill: &SkillTool,
    database: &DatabaseTool,
    mcp: &McpToolRegistry,
    subagents: Option<&SubAgentTool>,
    teams: Option<&TeamTool>,
    tool_settings: &ToolSettings,
    read_fingerprints: &HashMap<String, ReadFingerprint>,
    todo_list: &mut TodoListState,
    mode: AgentMode,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &TurnCancel,
    tool_call_id: &str,
    name: &str,
    input: Value,
) -> ToolRunResult {
    let canonical_name = tool_names::canonical_tool_name(name);
    if mode == AgentMode::Ask && !ask_mode_tool_allowed(canonical_name) {
        return ToolRunResult::err(
            format!("{canonical_name} is unavailable in Ask mode"),
            Vec::new(),
        );
    }
    if !tool_settings.is_enabled(canonical_name) {
        return ToolRunResult::err(
            format!("{canonical_name} is disabled in Settings"),
            Vec::new(),
        );
    }
    if canonical_name == tool_names::BASH {
        bash.run(input).await
    } else if canonical_name == tool_names::BASH_INPUT {
        bash.run_input(input).await
    } else if canonical_name == tool_names::PYTHON {
        python.run(input).await
    } else if canonical_name == tool_names::GLOB {
        glob.run(input).await
    } else if canonical_name == tool_names::GREP {
        grep.run(input).await
    } else if canonical_name == tool_names::READ {
        read.run(input).await
    } else if canonical_name == tool_names::EDIT_FILE {
        if mode == AgentMode::Plan {
            return ToolRunResult::err("edit_file is unavailable in Plan mode", Vec::new());
        }
        edit_file.run(input, read_fingerprints).await
    } else if canonical_name == tool_names::WRITE_FILE {
        if mode == AgentMode::Plan {
            return ToolRunResult::err("write_file is unavailable in Plan mode", Vec::new());
        }
        write_file.run(input, read_fingerprints).await
    } else if canonical_name == tool_names::CREATE_IMAGE {
        if mode == AgentMode::Plan {
            return ToolRunResult::err("create_image is unavailable in Plan mode", Vec::new());
        }
        create_image.run(input).await
    } else if canonical_name == tool_names::TODO_LIST {
        let Some(todo_list_tool) = todo_list_tool else {
            return ToolRunResult::err("todo_list is unavailable in this context", Vec::new());
        };
        todo_list_tool.run(input, todo_list).await
    } else if canonical_name == tool_names::QUESTION {
        let Some(question) = question else {
            return ToolRunResult::err("question is unavailable in this context", Vec::new());
        };
        question.run(tool_call_id, input, cancel).await
    } else if canonical_name == tool_names::WEB_SEARCH {
        web_search.run(input).await
    } else if canonical_name == tool_names::WEB_FETCH {
        web_fetch.run(input).await
    } else if canonical_name == tool_names::SKILL {
        skill.run(input).await
    } else if let Some(result) = database.run(name, input.clone(), question.is_some()).await {
        result
    } else if name.starts_with("subagent_") {
        let Some(subagents) = subagents else {
            return ToolRunResult::err(format!("unknown tool: {name}"), Vec::new());
        };
        subagents
            .run(tool_call_id, name, input, mode, event_tx.clone())
            .await
            .unwrap_or_else(|| ToolRunResult::err(format!("unknown tool: {name}"), Vec::new()))
    } else if let Some(teams) = teams {
        if let Some(result) = teams
            .run(tool_call_id, name, input.clone(), mode, event_tx.clone())
            .await
        {
            result
        } else if let Some(result) = mcp.run_tool(name, input).await {
            result
        } else {
            ToolRunResult::err(format!("unknown tool: {name}"), Vec::new())
        }
    } else if let Some(result) = mcp.run_tool(name, input).await {
        result
    } else {
        ToolRunResult::err(format!("unknown tool: {name}"), Vec::new())
    }
}

fn ask_mode_tool_allowed(name: &str) -> bool {
    matches!(
        name,
        tool_names::GLOB
            | tool_names::GREP
            | tool_names::READ
            | tool_names::WEB_SEARCH
            | tool_names::WEB_FETCH
            | tool_names::CLEAN_CONTEXT
    )
}

#[cfg(test)]
mod tests {
    use super::ask_mode_tool_allowed;
    use crate::tool_names;

    #[test]
    fn ask_mode_allows_only_read_and_research_tools() {
        for name in [
            tool_names::GLOB,
            tool_names::GREP,
            tool_names::READ,
            tool_names::WEB_SEARCH,
            tool_names::WEB_FETCH,
            tool_names::CLEAN_CONTEXT,
        ] {
            assert!(ask_mode_tool_allowed(name), "{name} should be allowed");
        }
        for name in [
            tool_names::BASH,
            tool_names::PYTHON,
            tool_names::EDIT_FILE,
            tool_names::WRITE_FILE,
            tool_names::CREATE_IMAGE,
            tool_names::TODO_LIST,
        ] {
            assert!(!ask_mode_tool_allowed(name), "{name} should be blocked");
        }
    }
}
