use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use claakecode_core::ToolDescriptor;

use crate::{store::DEFAULT_PLAN_MODE_PROMPT, GoalWorkflowState, ToolRunResult};

use super::context::AgentMode;

const ASK_MODE_PROMPT: &str = r#"You are in Ask mode.

Rules:
- Analyze, explain, compare, and reason about the workspace without changing it.
- You may inspect any workspace code and use web search or web fetch for external research.
- Do not implement changes, edit or create files, run shell commands, execute Python, delegate to agents, call MCP tools, or access databases.
- If the user asks you to implement something, provide guidance or an implementation approach only and clearly state that Ask mode does not modify code."#;

const GOAL_MODE_PROMPT: &str = r#"You are in Goal mode.

Rules:
- Work autonomously toward the objective across as many turns as needed.
- Do not treat one answer as the end of the goal unless the objective is genuinely complete.
- Do not repeat completed work. First orient from existing context, then continue from the next useful step.
- Use tools and make edits normally, like Act mode.
- Before deciding the goal is complete, audit the objective against the current workspace state.
- When the objective is truly complete, you MUST call update_goal with status "complete" before your final response.
- If the objective is not complete by the end of this turn, briefly report progress and the next step. The app will continue automatically."#;

pub(super) fn update_goal_descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: "update_goal".into(),
        description: "Mark the active Goal mode objective complete. Use this only after auditing that the full objective is genuinely finished.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["complete"],
                    "description": "Use complete only when the goal is truly done."
                },
                "summary": {
                    "type": "string",
                    "description": "A concise summary of what was completed."
                }
            },
            "required": ["status"],
            "additionalProperties": false
        }),
    }
}

pub(super) fn run_update_goal(
    goal_workflow: &mut GoalWorkflowState,
    input: Value,
) -> ToolRunResult {
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status != "complete" {
        return ToolRunResult::err("status must be complete", Vec::new());
    }

    let Some((objective, started_at_ms)) = goal_objective_and_started(goal_workflow) else {
        return ToolRunResult::err("no active goal to update", Vec::new());
    };
    *goal_workflow = GoalWorkflowState::Complete {
        objective,
        started_at_ms,
        completed_at_ms: now_ms(),
    };

    let summary = input
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Goal marked complete");
    ToolRunResult::ok(summary.to_string(), Vec::new())
}

fn goal_objective_and_started(goal_workflow: &GoalWorkflowState) -> Option<(String, i64)> {
    match goal_workflow {
        GoalWorkflowState::Active {
            objective,
            started_at_ms,
            ..
        }
        | GoalWorkflowState::Paused {
            objective,
            started_at_ms,
            ..
        }
        | GoalWorkflowState::Complete {
            objective,
            started_at_ms,
            ..
        } => Some((objective.clone(), *started_at_ms)),
        GoalWorkflowState::Idle => None,
    }
}

pub(super) fn goal_objective(goal_workflow: &GoalWorkflowState) -> Option<&str> {
    match goal_workflow {
        GoalWorkflowState::Active { objective, .. }
        | GoalWorkflowState::Paused { objective, .. }
        | GoalWorkflowState::Complete { objective, .. } => Some(objective.as_str()),
        GoalWorkflowState::Idle => None,
    }
}

/// A goal that ends this many turns in a row without calling a tool is paused.
pub const GOAL_MAX_IDLE_TURNS: u32 = 3;

/// Counts a finished goal turn. Returns the new state and `true` when the goal was
/// paused because it stayed idle `GOAL_MAX_IDLE_TURNS` turns in a row.
pub fn record_goal_turn(workflow: GoalWorkflowState, used_tools: bool) -> (GoalWorkflowState, bool) {
    match workflow {
        GoalWorkflowState::Active { objective, started_at_ms, updated_at_ms, idle_turns } => {
            let idle_turns = if used_tools { 0 } else { idle_turns.saturating_add(1) };
            if idle_turns >= GOAL_MAX_IDLE_TURNS {
                (GoalWorkflowState::Paused { objective, started_at_ms, updated_at_ms: now_ms() }, true)
            } else {
                (GoalWorkflowState::Active { objective, started_at_ms, updated_at_ms, idle_turns }, false)
            }
        }
        other => (other, false),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub fn system_prompt_for_mode(base: &str, mode: AgentMode) -> String {
    system_prompt_for_mode_with_plan_prompt(base, mode, DEFAULT_PLAN_MODE_PROMPT)
}

pub fn system_prompt_for_mode_with_plan_prompt(
    base: &str,
    mode: AgentMode,
    plan_mode_prompt: &str,
) -> String {
    match mode {
        AgentMode::Act => base.to_string(),
        AgentMode::Ask => format!("{base}\n\n<ask_mode>\n{ASK_MODE_PROMPT}\n</ask_mode>"),
        AgentMode::Plan => format!(
            "{base}\n\n<plan_mode>\n{}\n</plan_mode>",
            effective_plan_mode_prompt(plan_mode_prompt)
        ),
        AgentMode::Goal => format!("{base}\n\n<goal_mode>\n{GOAL_MODE_PROMPT}\n</goal_mode>"),
    }
}

fn effective_plan_mode_prompt(plan_mode_prompt: &str) -> &str {
    let prompt = plan_mode_prompt.trim();
    if prompt.is_empty() {
        DEFAULT_PLAN_MODE_PROMPT
    } else {
        prompt
    }
}

pub(super) fn system_prompt_for_turn(
    base: &str,
    mode: AgentMode,
    goal_workflow: &GoalWorkflowState,
    plan_mode_prompt: &str,
) -> String {
    let prompt = system_prompt_for_mode_with_plan_prompt(base, mode, plan_mode_prompt);
    if mode != AgentMode::Goal {
        return prompt;
    }
    let Some(objective) = goal_objective(goal_workflow) else {
        return prompt;
    };
    format!("{prompt}\n\n<goal_objective>\n{objective}\n</goal_objective>")
}

#[cfg(test)]
mod idle_goal_tests {
    use super::*;

    fn active(idle_turns: u32) -> GoalWorkflowState {
        GoalWorkflowState::Active { objective: "o".into(), started_at_ms: 1, updated_at_ms: 1, idle_turns }
    }

    #[test]
    fn goal_pauses_after_three_idle_turns() {
        let (state, paused) = record_goal_turn(active(0), false);
        assert_eq!(state, active(1));
        assert!(!paused);
        let (state, paused) = record_goal_turn(state, false);
        assert_eq!(state, active(2));
        assert!(!paused);
        let (state, paused) = record_goal_turn(state, false);
        assert!(paused);
        assert!(matches!(state, GoalWorkflowState::Paused { ref objective, .. } if objective == "o"));
    }

    #[test]
    fn a_tool_call_resets_the_idle_count() {
        let (state, paused) = record_goal_turn(active(2), true);
        assert_eq!(state, active(0));
        assert!(!paused);
    }

    #[test]
    fn non_active_goals_are_left_alone() {
        let (state, paused) = record_goal_turn(GoalWorkflowState::Idle, false);
        assert_eq!(state, GoalWorkflowState::Idle);
        assert!(!paused);
    }

    #[test]
    fn old_saved_goals_without_idle_turns_still_load() {
        let state: GoalWorkflowState = serde_json::from_value(json!({
            "status": "active", "objective": "o", "started_at_ms": 1, "updated_at_ms": 1
        }))
        .unwrap();
        assert_eq!(state, active(0));
        assert!(!serde_json::to_string(&state).unwrap().contains("idle_turns"));
    }
}
