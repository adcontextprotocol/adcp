//! State- and PKCE-bound native authentication for Addie Desktop.

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd",
)))]
compile_error!("Addie authentication requires a persistent native keyring backend");

use keyring::{Entry, Error as KeyringError};
use serde::Deserialize;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::auth_flow::{
    new_pending_login, start_request, token_request, validate_callback, CallbackError,
    CallbackOutcome, PendingLogin,
};
use crate::{AuthRuntime, UserSession};

const KEYRING_SERVICE: &str = "org.agenticadvertising.addie";
const SESSION_KEYRING_USER: &str = "session-v2";
const PENDING_KEYRING_USER: &str = "oauth-pending-v2";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
struct StartResponse {
    authorization_url: String,
}

#[derive(Deserialize)]
struct TokenUser {
    id: String,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    sealed_session: String,
    user: TokenUser,
}

fn now_seconds() -> Result<u64, Box<dyn std::error::Error>> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn get_api_origin() -> Result<String, Box<dyn std::error::Error>> {
    let configured = std::env::var("ADDIE_API_URL")
        .unwrap_or_else(|_| "https://agenticadvertising.org".to_string());
    let parsed = Url::parse(&configured)?;
    let local_debug = cfg!(debug_assertions)
        && parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.host_str().is_none()
        || (!local_debug && parsed.scheme() != "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("ADDIE_API_URL must be an HTTPS origin".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn entry(user: &str) -> Result<Entry, Box<dyn std::error::Error>> {
    Ok(Entry::new(KEYRING_SERVICE, user)?)
}

fn auth_http_client() -> Result<reqwest::Client, Box<dyn std::error::Error>> {
    Ok(reqwest::Client::builder()
        // Never replay state, authorization codes, or PKCE verifiers to a
        // redirect target. These endpoints are expected to return JSON.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()?)
}

fn save_pending(pending: &PendingLogin) -> Result<(), Box<dyn std::error::Error>> {
    entry(PENDING_KEYRING_USER)?.set_password(&serde_json::to_string(pending)?)?;
    Ok(())
}

fn get_pending() -> Result<Option<PendingLogin>, Box<dyn std::error::Error>> {
    match entry(PENDING_KEYRING_USER)?.get_password() {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn clear_pending_if_state(state: &str) {
    if let Ok(Some(current)) = get_pending() {
        if current.state == state {
            let _ = entry(PENDING_KEYRING_USER)
                .and_then(|value| value.delete_credential().map_err(Into::into));
        }
    }
}

fn clear_pending() -> Result<(), Box<dyn std::error::Error>> {
    match entry(PENDING_KEYRING_USER)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn append_bounded_response_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    if body
        .len()
        .checked_add(chunk.len())
        .is_none_or(|size| size > MAX_RESPONSE_BYTES)
    {
        return Err("Authentication response too large".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn parse_json_response<T: for<'de> Deserialize<'de>>(
    mut response: reqwest::Response,
) -> Result<T, Box<dyn std::error::Error>> {
    if !response.status().is_success() {
        return Err(format!("Authentication server returned {}", response.status()).into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Authentication response too large".into());
    }
    let capacity = response.content_length().unwrap_or(0) as usize;
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await? {
        append_bounded_response_chunk(&mut body, &chunk)?;
    }
    Ok(serde_json::from_slice(&body)?)
}

pub async fn start_oauth_flow(
    app: &AppHandle,
    runtime: &AuthRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
    let _guard = runtime.flow_lock.lock().await;
    let api_origin = get_api_origin()?;
    let pending = new_pending_login(api_origin.clone(), now_seconds()?);
    save_pending(&pending)?;

    let result = async {
        let client = auth_http_client()?;
        let response = client
            .post(format!("{api_origin}/auth/native/start"))
            .json(&start_request(&pending))
            .send()
            .await?;
        let start: StartResponse = parse_json_response(response).await?;
        let authorization_url = Url::parse(&start.authorization_url)?;
        if authorization_url.scheme() != "https" {
            return Err("Authorization URL must use HTTPS".into());
        }
        app.opener()
            .open_url(authorization_url.as_str(), None::<&str>)?;
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;

    if result.is_err() {
        clear_pending_if_state(&pending.state);
    }
    result
}

pub async fn handle_deep_link(
    app: &AppHandle,
    runtime: &AuthRuntime,
    raw_url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let _guard = runtime.flow_lock.lock().await;
    let Some(pending) = get_pending()? else {
        return Ok(());
    };

    let outcome = match validate_callback(raw_url, &pending, now_seconds()?) {
        Ok(outcome) => outcome,
        Err(CallbackError::NotAuthCallback | CallbackError::StateMismatch) => return Ok(()),
        Err(CallbackError::Expired) => {
            clear_pending_if_state(&pending.state);
            let _ = app.emit("auth-error", "login_expired");
            return Ok(());
        }
        Err(_) => {
            let _ = app.emit("auth-error", "invalid_callback");
            return Ok(());
        }
    };

    // A matching callback is single-use locally. A failed exchange requires a
    // fresh login rather than allowing callback replay.
    clear_pending()?;

    match outcome {
        CallbackOutcome::Error { code } => {
            let event_code = if code == "access_denied" {
                "access_denied"
            } else {
                "authentication_failed"
            };
            let _ = app.emit("auth-error", event_code);
            Ok(())
        }
        CallbackOutcome::Code { code } => {
            let client = auth_http_client()?;
            let response = client
                .post(format!("{}/auth/native/token", pending.api_origin))
                .json(&token_request(&pending, &code))
                .send()
                .await?;
            let token: TokenResponse = parse_json_response(response).await?;
            if token.sealed_session.is_empty()
                || token.sealed_session.len() > MAX_RESPONSE_BYTES
                || token.user.id.is_empty()
                || token.user.id.len() > 256
                || token.user.email.is_empty()
                || token.user.email.len() > 320
            {
                return Err("Invalid authentication response".into());
            }
            let session = UserSession {
                sealed_session: token.sealed_session,
                user_id: token.user.id.clone(),
                email: token.user.email.clone(),
                first_name: token.user.first_name.clone(),
                last_name: token.user.last_name.clone(),
            };
            save_session(&session)?;
            let _ = app.emit(
                "auth-success",
                serde_json::json!({
                    "user": {
                        "id": token.user.id,
                        "email": token.user.email,
                        "first_name": token.user.first_name,
                        "last_name": token.user.last_name,
                    }
                }),
            );

            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        }
    }
}

pub fn save_session(session: &UserSession) -> Result<(), Box<dyn std::error::Error>> {
    delete_legacy_session_file()?;
    entry(SESSION_KEYRING_USER)?.set_password(&serde_json::to_string(session)?)?;
    Ok(())
}

pub fn get_session() -> Result<Option<UserSession>, Box<dyn std::error::Error>> {
    // V1 sessions were stored as plaintext and may have been installed by an
    // unsolicited deep link. Never migrate them as authenticated sessions.
    delete_legacy_session_file()?;
    match entry(SESSION_KEYRING_USER)?.get_password() {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn delete_legacy_session_file() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    match std::fs::remove_file(home.join(".addie-session.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn clear_session() -> Result<(), Box<dyn std::error::Error>> {
    for user in [SESSION_KEYRING_USER, PENDING_KEYRING_USER] {
        match entry(user)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(error.into()),
        }
    }
    delete_legacy_session_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyring_uses_the_native_platform_backend() {
        let credential = entry("native-backend-probe").unwrap();
        let credential = credential.get_credential();

        #[cfg(target_os = "macos")]
        assert!(credential.is::<keyring::macos::MacCredential>());

        #[cfg(target_os = "ios")]
        assert!(credential.is::<keyring::ios::IosCredential>());

        #[cfg(target_os = "windows")]
        assert!(credential.is::<keyring::windows::WinCredential>());

        #[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "openbsd"))]
        assert!(credential.is::<keyring::secret_service::SsCredential>());
    }

    #[test]
    fn rejects_an_oversized_chunk_before_buffering_it() {
        let mut body = vec![b'a'; MAX_RESPONSE_BYTES - 2];
        append_bounded_response_chunk(&mut body, b"bc").unwrap();
        assert_eq!(body.len(), MAX_RESPONSE_BYTES);

        let snapshot = body.clone();
        assert!(append_bounded_response_chunk(&mut body, b"d").is_err());
        assert_eq!(body, snapshot);
    }
}
