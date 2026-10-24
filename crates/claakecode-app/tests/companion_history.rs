//! Historique du compagnon Claaky2D et construction de la requête Ask.

use claakecode_app::companion::{
    companion_allowed_models_setting, companion_default_model_setting, companion_history_delete,
    companion_history_list, companion_history_load, companion_history_save, companion_model_value,
    companion_provider_request, companion_title_from, parse_companion_model, CompanionAttachment,
    CompanionConversation, CompanionMessage,
};
use claakecode_app::store::AppStore;
use claakecode_core::{Part, Role};
use serde_json::json;

fn message(role: &str, text: &str, at: i64) -> CompanionMessage {
    CompanionMessage {
        id: format!("{role}-{at}"),
        role: role.into(),
        text: text.into(),
        attachment_names: Vec::new(),
        created_at_ms: at,
        error: None,
    }
}

fn conversation(
    id: &str,
    updated_at_ms: i64,
    messages: Vec<CompanionMessage>,
) -> CompanionConversation {
    CompanionConversation {
        id: id.into(),
        title: format!("titre {id}"),
        updated_at_ms,
        model: "anthropic:claude".into(),
        messages,
    }
}

#[test]
fn history_save_load_roundtrip() {
    let store = AppStore::in_memory().unwrap();
    let mut user = message("user", "Bonjour", 10);
    user.attachment_names = vec!["capture.png".into()];
    let mut failed = message("assistant", "", 11);
    failed.error = Some("quota".into());
    companion_history_save(&store, &conversation("c1", 11, vec![user, failed])).unwrap();

    let loaded = companion_history_load(&store, "c1")
        .unwrap()
        .expect("conversation enregistrée");
    assert_eq!(loaded.title, "titre c1");
    assert_eq!(loaded.model, "anthropic:claude");
    assert_eq!(loaded.messages.len(), 2);
    assert_eq!(loaded.messages[0].attachment_names, vec!["capture.png"]);
    assert_eq!(loaded.messages[1].error.as_deref(), Some("quota"));
    assert!(companion_history_load(&store, "absente").unwrap().is_none());
}

#[test]
fn history_save_upserts_existing_conversation() {
    let store = AppStore::in_memory().unwrap();
    companion_history_save(
        &store,
        &conversation("c1", 1, vec![message("user", "a", 1)]),
    )
    .unwrap();
    let mut updated = conversation(
        "c1",
        5,
        vec![message("user", "a", 1), message("assistant", "b", 5)],
    );
    updated.model = "openai:gpt".into();
    companion_history_save(&store, &updated).unwrap();

    assert_eq!(companion_history_list(&store).unwrap().len(), 1);
    let loaded = companion_history_load(&store, "c1").unwrap().unwrap();
    assert_eq!(loaded.messages.len(), 2);
    assert_eq!(loaded.model, "openai:gpt");
    assert_eq!(loaded.updated_at_ms, 5);
}

#[test]
fn history_list_is_most_recent_first_and_delete_removes() {
    let store = AppStore::in_memory().unwrap();
    for (id, at) in [("old", 1), ("new", 3), ("mid", 2)] {
        companion_history_save(&store, &conversation(id, at, vec![message("user", id, at)]))
            .unwrap();
    }
    let ids: Vec<_> = companion_history_list(&store)
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec!["new", "mid", "old"]);

    companion_history_delete(&store, "mid").unwrap();
    companion_history_delete(&store, "absente").unwrap();
    let ids: Vec<_> = companion_history_list(&store)
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec!["new", "old"]);
}

#[test]
fn history_is_separate_from_main_conversations() {
    let store = AppStore::in_memory().unwrap();
    assert!(companion_history_list(&store).unwrap().is_empty());
}

#[test]
fn provider_request_skips_errors_and_bounds_history() {
    let mut history: Vec<_> = (0..30)
        .map(|i| {
            message(
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("m{i}"),
                i,
            )
        })
        .collect();
    let mut failed = message("assistant", "erreur", 99);
    failed.error = Some("boom".into());
    history.push(failed);
    history.push(message("user", "   ", 100));

    let model = parse_companion_model("anthropic:claude").unwrap();
    let request = companion_provider_request(model, &history, "question", &[]);
    // 24 messages d'historique au plus + le message courant.
    assert_eq!(request.transcript.len(), 25);
    let first = &request.transcript[0];
    assert!(matches!(&first.parts[0], Part::Text { text, .. } if text == "m6"));
    let last = request.transcript.last().unwrap();
    assert_eq!(last.role, Role::User);
    assert!(matches!(&last.parts[0], Part::Text { text, .. } if text == "question"));
}

#[test]
fn provider_request_inlines_text_and_appends_images() {
    let attachments = vec![
        CompanionAttachment::Image {
            name: "zone.png".into(),
            mime: "image/png".into(),
            data_base64: "AAAA".into(),
        },
        CompanionAttachment::Text {
            name: "log.txt".into(),
            text: "stack".into(),
        },
    ];
    let model = parse_companion_model("anthropic:claude").unwrap();
    let request = companion_provider_request(model, &[], "explique", &attachments);
    let parts = &request.transcript[0].parts;
    assert_eq!(parts.len(), 2);
    assert!(
        matches!(&parts[0], Part::Text { text, .. } if text.starts_with("explique") && text.contains("[Pièce jointe : log.txt]\nstack"))
    );
    assert!(
        matches!(&parts[1], Part::Image { media_type, data, .. } if media_type == "image/png" && data == "AAAA")
    );
}

#[test]
fn model_parsing() {
    let model = parse_companion_model(" ollama : llama3:8b ").unwrap();
    assert_eq!(companion_model_value(&model), "ollama:llama3:8b");
    assert!(parse_companion_model("sans-separateur").is_err());
    assert!(parse_companion_model(":id").is_err());
    assert!(parse_companion_model("provider:").is_err());
}

#[test]
fn title_and_settings_helpers() {
    assert_eq!(
        companion_title_from("  bonjour \n  Claaky "),
        "bonjour Claaky"
    );
    assert_eq!(companion_title_from("   "), "Nouvelle conversation");
    let long = "é".repeat(80);
    assert_eq!(companion_title_from(&long).chars().count(), 61);

    let settings = json!({ "defaultModel": "  ", "allowedModels": [" a:1 ", "", 3, "b:2"] });
    assert_eq!(companion_default_model_setting(Some(&settings)), None);
    assert_eq!(
        companion_allowed_models_setting(Some(&settings)),
        vec!["a:1", "b:2"]
    );
    assert!(companion_allowed_models_setting(None).is_empty());
}
