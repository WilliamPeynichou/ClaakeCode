//! Tauri commands for the TypeSafe (Jev) provider.
//!
//! Scope is deliberately narrow: store one API key, report whether one exists.
//! Claake Code never calls the TypeSafe API on the user's behalf and never
//! injects the key into tool runs. Every error string is redacted before it
//! leaves this module.

use crate::*;

#[tauri::command]
pub(super) async fn typesafe_get_settings(
    state: State<'_, DesktopState>,
) -> std::result::Result<TypeSafeSettings, String> {
    state
        .store
        .load_typesafe_settings()
        .map_err(|err| state.store.redact_typesafe_message(error_to_string(err)))
}

#[tauri::command]
pub(super) async fn typesafe_save_token(
    state: State<'_, DesktopState>,
    input: TypeSafeTokenInput,
) -> std::result::Result<TypeSafeSettings, String> {
    state
        .store
        .save_typesafe_token(&input.token)
        .map_err(|err| state.store.redact_typesafe_message(error_to_string(err)))
}

#[tauri::command]
pub(super) async fn typesafe_clear_token(
    state: State<'_, DesktopState>,
) -> std::result::Result<TypeSafeSettings, String> {
    state
        .store
        .clear_typesafe_token()
        .map_err(|err| state.store.redact_typesafe_message(error_to_string(err)))
}
