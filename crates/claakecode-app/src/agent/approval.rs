use tokio::sync::mpsc;

use super::{
    cancel::{QuestionReply, TurnCancel},
    events::{send_event, AgentEvent, AgentEventScope},
};

/// Bloque jusqu'à la réponse de l'utilisateur. Sans réponse, annulé ou rejeté : refus.
pub(super) async fn request_approval(
    cancel: &TurnCancel,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    scope: Option<&AgentEventScope>,
    tool_call_id: &str,
    name: &str,
    detail: String,
) -> bool {
    if cancel.is_tool_approved(name) {
        return true;
    }
    let key = format!("approval:{tool_call_id}");
    let Ok(receiver) = cancel.register_question(key.clone()) else {
        return false;
    };
    send_event(
        event_tx,
        scope,
        AgentEvent::ApprovalRequested {
            id: tool_call_id.into(),
            name: name.into(),
            detail,
        },
    );
    match receiver.await {
        Ok(QuestionReply::Answer { answers, .. }) => {
            if answers.first().and_then(|a| a.first()).map(String::as_str) == Some("turn") {
                cancel.approve_tool(name);
            }
            true
        }
        _ => {
            cancel.unregister_question(&key);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn approval_blocks_until_answer() {
        let cancel = TurnCancel::empty();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = {
            let cancel = cancel.clone();
            tokio::spawn(async move { request_approval(&cancel, &tx, None, "t1", "bash", "{}".into()).await })
        };
        // L'événement arrive après l'enregistrement de la question.
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap();
        assert!(matches!(event, Some(AgentEvent::ApprovalRequested { .. })));
        assert!(!task.is_finished());
        assert!(cancel.answer_question("approval:t1", vec![vec!["once".into()]], false));
        assert!(task.await.unwrap());
    }

    #[tokio::test]
    async fn rejection_and_turn_scope() {
        let cancel = TurnCancel::empty();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let task = {
            let (cancel, tx) = (cancel.clone(), tx.clone());
            tokio::spawn(async move { request_approval(&cancel, &tx, None, "t1", "bash", "{}".into()).await })
        };
        rx.recv().await.unwrap();
        assert!(cancel.reject_question("approval:t1"));
        assert!(!task.await.unwrap());
        assert!(!cancel.is_tool_approved("bash"));

        let task = {
            let (cancel, tx) = (cancel.clone(), tx.clone());
            tokio::spawn(async move { request_approval(&cancel, &tx, None, "t2", "bash", "{}".into()).await })
        };
        rx.recv().await.unwrap();
        assert!(cancel.answer_question("approval:t2", vec![vec!["turn".into()]], false));
        assert!(task.await.unwrap());

        assert!(request_approval(&cancel, &tx, None, "t3", "bash", "{}".into()).await);
        assert!(rx.try_recv().is_err());
    }
}
