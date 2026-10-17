use crate::*;

// Régulation du flux d'événements d'un tour (lead et swarm).
//
// INVARIANT D'ORDRE GLOBAL : le lot conserve strictement l'ordre d'arrivée de
// tous les événements, tous agents confondus. Un delta n'est fusionné qu'avec
// le dernier élément du lot (la queue), et seulement si c'est un delta de même
// nature (même agent, même type, même outil). Tout autre événement se place
// après la queue, donc aucun réordonnancement n'est possible.

pub(super) const EVENT_PUMP_FLUSH_MS: u64 = 16;
pub(super) const EVENT_PUMP_FLUSH_BYTES: usize = 64 * 1024;
pub(super) const EVENT_PUMP_MAX_BATCH_EVENTS: usize = 512;
/// Intervalle minimal entre deux sauvegardes provisoires d'un tour en cours.
pub(super) const PARTIAL_TURN_SAVE_INTERVAL_MS: u64 = 5_000;

/// Sauvegarde provisoire d'un tour en cours : si l'app est tuée (gel, crash,
/// watchdog WindowServer), la réponse déjà reçue n'est pas perdue au redémarrage.
/// Seul le texte du lead est conservé, en un message assistant texte : pas de
/// bloc d'outil orphelin. La sauvegarde finale du tour écrase ce brouillon.
pub(super) struct PartialTurnCheckpoint {
    base: SavedConversation,
    text: String,
    dirty: bool,
    last_saved_at: tokio::time::Instant,
}

impl PartialTurnCheckpoint {
    pub(super) fn new(base: SavedConversation) -> Self {
        Self {
            base,
            text: String::new(),
            dirty: false,
            last_saved_at: tokio::time::Instant::now(),
        }
    }

    /// Accumule uniquement le texte du lead (les événements des teammates sont ignorés).
    pub(super) fn observe(&mut self, event: &AgentEvent) {
        if let AgentEvent::TextChunk { delta } = event {
            if !delta.is_empty() {
                self.text.push_str(delta);
                self.dirty = true;
            }
        }
    }

    /// Brouillon à sauvegarder si l'intervalle est écoulé et qu'il y a du nouveau texte.
    pub(super) fn due_snapshot(&mut self) -> Option<SavedConversation> {
        if !self.dirty
            || self.last_saved_at.elapsed() < Duration::from_millis(PARTIAL_TURN_SAVE_INTERVAL_MS)
        {
            return None;
        }
        self.dirty = false;
        self.last_saved_at = tokio::time::Instant::now();
        let mut snapshot = self.base.clone();
        snapshot
            .history
            .push(ChatMessage::assistant_text(self.text.trim_end().to_string()));
        Some(snapshot)
    }

    pub(super) fn maybe_save(&mut self, store: &AppStore) {
        if let Some(snapshot) = self.due_snapshot() {
            let _ = store.save_conversation(&snapshot);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BatchedAgentEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) sequence: Option<u64>,
    pub(super) event: AgentEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConversationEventBatch {
    pub(super) workspace_id: String,
    pub(super) conversation_id: String,
    pub(super) events: Vec<BatchedAgentEvent>,
}

/// Émet un lot d'événements dans l'ordre d'arrivée.
/// Effets identiques à l'ancien bras unitaire, appliqués à chaque événement :
/// wake du swarm, fichiers modifiés, séquence de replay. Un seul émit IPC par lot.
pub(super) fn emit_agent_event_batch(
    app: &AppHandle,
    workspace_id: &str,
    conversation_id: &str,
    batch: Vec<AgentEvent>,
    state: &DesktopState,
    workspace_root: &Path,
) {
    if batch.is_empty() {
        return;
    }
    let mut events = Vec::with_capacity(batch.len());
    let mut remote_events = Vec::with_capacity(batch.len());
    for event in batch {
        schedule_main_wake_for_swarm_event(app, state, workspace_root, conversation_id, &event);
        emit_agent_file_changes(app, workspace_id, &event);
        let sequence = remember_active_turn_event(app, conversation_id, event.clone());
        remote_events.push((sequence, event.clone()));
        events.push(BatchedAgentEvent { sequence, event });
    }
    forward_agent_events(app, workspace_id, conversation_id, remote_events);
    let payload = ConversationEventBatch {
        workspace_id: workspace_id.to_string(),
        conversation_id: conversation_id.to_string(),
        events,
    };
    let _ = app.emit(AGENT_EVENT_BATCH_NAME, payload);
}

/// Vide la file déjà reçue du tour (sans attendre) puis le lot en attente, dans l'ordre.
/// Appelé avant tout traitement de fin de moteur : aucun événement ne passe après la fin.
pub(super) fn drain_turn_events(
    app: &AppHandle,
    workspace_id: &str,
    conversation_id: &str,
    pump: &mut EventPump,
    event_rx: &mut mpsc::UnboundedReceiver<AgentEvent>,
    state: &DesktopState,
    workspace_root: &Path,
) {
    while let Ok(event) = event_rx.try_recv() {
        if matches!(event, AgentEvent::TurnFinished { .. }) {
            continue;
        }
        if pump.push(event) {
            let batch = pump.take();
            emit_agent_event_batch(app, workspace_id, conversation_id, batch, state, workspace_root);
        }
    }
    if pump.has_pending() {
        let batch = pump.take();
        emit_agent_event_batch(app, workspace_id, conversation_id, batch, state, workspace_root);
    }
}

/// Accumule les événements d'un tour et décide quand les émettre.
pub(super) struct EventPump {
    batch: Vec<AgentEvent>,
    batch_bytes: usize,
    first_pending_at: Option<tokio::time::Instant>,
}

impl EventPump {
    pub(super) fn new() -> Self {
        Self {
            batch: Vec::new(),
            batch_bytes: 0,
            first_pending_at: None,
        }
    }

    pub(super) fn has_pending(&self) -> bool {
        !self.batch.is_empty()
    }

    /// Instant du flush périodique. Sans lot en attente, retourne un instant lointain
    /// (la branche de `select!` est désactivée par `has_pending`).
    pub(super) fn flush_deadline(&self) -> tokio::time::Instant {
        match self.first_pending_at {
            Some(first) => first + Duration::from_millis(EVENT_PUMP_FLUSH_MS),
            None => tokio::time::Instant::now() + Duration::from_secs(3600),
        }
    }

    /// Ajoute un événement dans l'ordre. Retourne `true` si le lot doit partir maintenant
    /// (événement terminal, seuil d'octets ou de nombre atteint).
    pub(super) fn push(&mut self, event: AgentEvent) -> bool {
        let bytes = approx_event_bytes(&event);
        let urgent = is_flush_urgent(&event);
        if let Some(tail) = self.batch.last_mut() {
            if merge_delta_event(tail, &event) {
                self.batch_bytes = self.batch_bytes.saturating_add(bytes);
                return urgent || self.is_full();
            }
        }
        if self.batch.is_empty() {
            self.first_pending_at = Some(tokio::time::Instant::now());
        }
        self.batch.push(event);
        self.batch_bytes = self.batch_bytes.saturating_add(bytes);
        urgent || self.is_full()
    }

    /// Rend le lot en attente, dans l'ordre d'arrivée, et réinitialise la pompe.
    pub(super) fn take(&mut self) -> Vec<AgentEvent> {
        self.batch_bytes = 0;
        self.first_pending_at = None;
        std::mem::take(&mut self.batch)
    }

    fn is_full(&self) -> bool {
        self.batch.len() >= EVENT_PUMP_MAX_BATCH_EVENTS || self.batch_bytes >= EVENT_PUMP_FLUSH_BYTES
    }
}

/// Fusionne `incoming` dans `existing` si ce sont deux deltas de même nature
/// (même agent, même type, même outil). Retourne `false` sans modifier `existing` sinon.
pub(super) fn merge_delta_event(existing: &mut AgentEvent, incoming: &AgentEvent) -> bool {
    match (existing, incoming) {
        (AgentEvent::TextChunk { delta: existing }, AgentEvent::TextChunk { delta })
        | (AgentEvent::ThinkingChunk { delta: existing }, AgentEvent::ThinkingChunk { delta }) => {
            existing.push_str(delta);
            true
        }
        (
            AgentEvent::ToolArgsDelta {
                id: existing_id,
                delta: existing,
            },
            AgentEvent::ToolArgsDelta { id, delta },
        )
        | (
            AgentEvent::ToolOutputDelta {
                id: existing_id,
                delta: existing,
            },
            AgentEvent::ToolOutputDelta { id, delta },
        ) if existing_id == id => {
            existing.push_str(delta);
            true
        }
        (
            AgentEvent::SubAgentEvent {
                id: existing_id,
                event: existing_event,
                ..
            },
            AgentEvent::SubAgentEvent { id, event, .. },
        ) if existing_id == id => merge_delta_event(existing_event.as_mut(), event.as_ref()),
        _ => false,
    }
}

/// Estimation grossière de la taille retenue par un événement (pour les seuils).
pub(super) fn approx_event_bytes(event: &AgentEvent) -> usize {
    match event {
        AgentEvent::TextChunk { delta }
        | AgentEvent::ThinkingChunk { delta }
        | AgentEvent::ToolArgsDelta { delta, .. }
        | AgentEvent::ToolOutputDelta { delta, .. } => delta.len(),
        AgentEvent::ToolFinished { output, .. } => output.len() + 64,
        AgentEvent::Error { message } => message.len() + 64,
        AgentEvent::SubAgentEvent { event, .. } => approx_event_bytes(event) + 64,
        _ => 64,
    }
}

/// Événements qui doivent partir immédiatement, sans attendre le flush périodique.
pub(super) fn is_flush_urgent(event: &AgentEvent) -> bool {
    match event {
        AgentEvent::ToolFinished { .. }
        | AgentEvent::Error { .. }
        | AgentEvent::TurnFinished { .. }
        | AgentEvent::Interrupted
        | AgentEvent::AgentSlept => true,
        AgentEvent::SubAgentEvent { event, .. } => is_flush_urgent(event),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(delta: &str) -> AgentEvent {
        AgentEvent::TextChunk {
            delta: delta.to_string(),
        }
    }

    fn scoped(id: &str, event: AgentEvent) -> AgentEvent {
        AgentEvent::SubAgentEvent {
            id: id.to_string(),
            agent_id: format!("agent-{id}"),
            agent_name: id.to_string(),
            team_name: Some("team".to_string()),
            model: ModelRef {
                provider: "test".to_string(),
                name: "model".to_string(),
                effort: None,
                use_1m_context: None,
            },
            initial_message: None,
            event: Box::new(event),
        }
    }

    /// Développe chaque caractère de delta en jeton `scope|kind|id|char`, et chaque
    /// événement structurel en jeton `event|debug`. Deux flux égaux donnent le même
    /// contenu et le même ordre global.
    fn expand(events: &[AgentEvent]) -> Vec<String> {
        let mut tokens = Vec::new();
        for event in events {
            expand_one(event, "", &mut tokens);
        }
        tokens
    }

    fn expand_one(event: &AgentEvent, scope: &str, tokens: &mut Vec<String>) {
        match event {
            AgentEvent::TextChunk { delta } => {
                for c in delta.chars() {
                    tokens.push(format!("{scope}|text|{c}"));
                }
            }
            AgentEvent::ThinkingChunk { delta } => {
                for c in delta.chars() {
                    tokens.push(format!("{scope}|think|{c}"));
                }
            }
            AgentEvent::ToolArgsDelta { id, delta } => {
                for c in delta.chars() {
                    tokens.push(format!("{scope}|args:{id}|{c}"));
                }
            }
            AgentEvent::ToolOutputDelta { id, delta } => {
                for c in delta.chars() {
                    tokens.push(format!("{scope}|out:{id}|{c}"));
                }
            }
            AgentEvent::SubAgentEvent { id, event, .. } => {
                expand_one(event, id, tokens);
            }
            other => tokens.push(format!("{scope}|event|{other:?}")),
        }
    }

    /// Petit générateur déterministe (pas de dépendance aléatoire).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 33) as usize) % bound
        }
    }

    /// Flux entrelacé de `agents` teammates : deltas texte/thinking/outils et structurels.
    fn interleaved_stream(agents: usize, steps: usize, seed: u64) -> Vec<AgentEvent> {
        let mut rng = Lcg(seed);
        let mut events = Vec::new();
        for step in 0..steps {
            let agent = format!("agent-{}", rng.next(agents));
            let payload = format!("{step}:{} ", rng.next(1000));
            let event = match rng.next(10) {
                0 | 1 | 2 | 3 => text(&payload),
                4 | 5 => AgentEvent::ThinkingChunk { delta: payload },
                6 => AgentEvent::ToolArgsDelta {
                    id: format!("tool-{}", rng.next(3)),
                    delta: payload,
                },
                7 => AgentEvent::ToolOutputDelta {
                    id: format!("tool-{}", rng.next(3)),
                    delta: payload,
                },
                8 => AgentEvent::ToolStarted {
                    id: format!("tool-{step}"),
                    name: "bash".to_string(),
                },
                _ => AgentEvent::ToolFinished {
                    id: format!("tool-{step}"),
                    output: payload,
                    is_error: false,
                    file_changes: Vec::new(),
                    images: Vec::new(),
                    meta: None,
                },
            };
            events.push(scoped(&agent, event));
            if rng.next(7) == 0 {
                events.push(text("lead "));
            }
        }
        events.push(AgentEvent::TurnFinished { duration_ms: None });
        events
    }

    fn run_pump(events: &[AgentEvent]) -> Vec<AgentEvent> {
        let mut pump = EventPump::new();
        let mut out = Vec::new();
        for event in events {
            if pump.push(event.clone()) {
                out.extend(pump.take());
            }
        }
        out.extend(pump.take());
        out
    }

    #[test]
    fn same_key_deltas_are_coalesced_in_order() {
        let mut pump = EventPump::new();
        pump.push(text("a"));
        pump.push(text("b"));
        pump.push(text("c"));
        let batch = pump.take();
        assert_eq!(batch.len(), 1);
        assert!(matches!(&batch[0], AgentEvent::TextChunk { delta } if delta == "abc"));
    }

    #[test]
    fn other_key_is_never_merged_across_the_tail() {
        // A1, B1, A2 : A2 ne doit pas fusionner avec A1 (B1 est entre les deux).
        let mut pump = EventPump::new();
        pump.push(scoped("a", text("A1")));
        pump.push(scoped("b", text("B1")));
        pump.push(scoped("a", text("A2")));
        let batch = pump.take();
        assert_eq!(batch.len(), 3);
        assert_eq!(expand(&batch), expand(&[
            scoped("a", text("A1")),
            scoped("b", text("B1")),
            scoped("a", text("A2")),
        ]));
    }

    #[test]
    fn tool_deltas_are_keyed_by_tool_id() {
        let mut pump = EventPump::new();
        pump.push(AgentEvent::ToolArgsDelta {
            id: "t1".into(),
            delta: "x".into(),
        });
        pump.push(AgentEvent::ToolArgsDelta {
            id: "t2".into(),
            delta: "y".into(),
        });
        pump.push(AgentEvent::ToolArgsDelta {
            id: "t2".into(),
            delta: "z".into(),
        });
        let batch = pump.take();
        assert_eq!(batch.len(), 2);
        assert!(matches!(&batch[1], AgentEvent::ToolArgsDelta { id, delta } if id == "t2" && delta == "yz"));
    }

    #[test]
    fn terminal_and_structural_events_request_immediate_flush() {
        let mut pump = EventPump::new();
        assert!(!pump.push(text("hello")));
        assert!(pump.push(AgentEvent::ToolFinished {
            id: "t".into(),
            output: String::new(),
            is_error: false,
            file_changes: Vec::new(),
            images: Vec::new(),
            meta: None,
        }));
        assert!(pump.push(AgentEvent::Error { message: "boom".into() }));
        assert!(pump.push(scoped("a", AgentEvent::Error { message: "x".into() })));
        assert!(pump.push(AgentEvent::TurnFinished { duration_ms: None }));
        assert!(pump.push(AgentEvent::Interrupted));
        assert!(pump.push(AgentEvent::AgentSlept));
        assert!(!pump.push(AgentEvent::TextStarted));
    }

    #[test]
    fn byte_threshold_forces_flush() {
        let mut pump = EventPump::new();
        let big = "x".repeat(EVENT_PUMP_FLUSH_BYTES);
        assert!(pump.push(text(&big)));
        let batch = pump.take();
        assert_eq!(batch.len(), 1);
        assert!(!pump.has_pending());
    }

    #[test]
    fn interleaved_streams_keep_exact_content_and_order() {
        for (agents, seed) in [(2usize, 11u64), (4, 23), (8, 37), (8, 41)] {
            let stream = interleaved_stream(agents, 1_500, seed);
            let coalesced = run_pump(&stream);
            assert_eq!(
                expand(&coalesced),
                expand(&stream),
                "agents={agents} seed={seed}"
            );
            assert!(
                coalesced.len() < stream.len(),
                "coalescing must reduce the number of events (agents={agents})"
            );
            assert!(matches!(
                coalesced.last(),
                Some(AgentEvent::TurnFinished { .. })
            ));
        }
    }

    #[test]
    fn terminal_flush_drains_pending_deltas_before_the_terminal_event() {
        let stream = vec![
            scoped("a", text("partial ")),
            scoped("a", text("answer")),
            AgentEvent::TurnFinished { duration_ms: None },
        ];
        let out = run_pump(&stream);
        assert_eq!(expand(&out), expand(&stream));
        assert!(matches!(out.last(), Some(AgentEvent::TurnFinished { .. })));
    }
}
