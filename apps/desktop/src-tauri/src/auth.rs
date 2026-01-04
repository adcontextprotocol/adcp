//! Authentication module for Addie Desktop
//!
//! Handles OAuth flow with WorkOS via deep links and secure session storage.

use keyring::Entry;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::UserSession;

const KEYRING_SERVICE: &str = "org.agenticadvertising.addie";
const KEYRING_USER: &str = "session";

/// Get API base URL
fn get_api_base_url() -> String {
    std::env::var("ADDIE_API_URL")
        .unwrap_or_else(|_| "https://agenticadvertising.org".to_string())
}

/// Start OAuth flow by opening browser to login page
pub fn start_oauth_flow(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let api_base = get_api_base_url();
    // The login URL will redirect to WorkOS, which will callback with sealed session in deep link
    let login_url = format!(
        "{}/auth/login?native=true&redirect_uri={}",
        api_base,
        urlencoding::encode("addie://auth/callback")
    );

    // Open in system browser using OpenerExt trait
    app.opener().open_url(&login_url, None::<&str>)?;

    Ok(())
}

/// Handle deep link callback from OAuth flow
/// URL format: addie://auth/callback?sealed_session=xxx&user_id=xxx&email=xxx&first_name=xxx&last_name=xxx
pub fn handle_deep_link(app: &AppHandle, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let parsed = url::Url::parse(url)?;

    // Check if this is an auth callback
    if parsed.scheme() != "addie" || parsed.host_str() != Some("auth") {
        return Ok(()); // Not an auth URL, ignore
    }

    if parsed.path() != "/callback" {
        return Ok(());
    }

    // Extract session data from query params (server sends sealed session directly)
    let params: std::collections::HashMap<_, _> = parsed.query_pairs().collect();

    let sealed_session = params
        .get("sealed_session")
        .map(|v| v.to_string())
        .ok_or("Missing sealed_session")?;

    let user_id = params
        .get("user_id")
        .map(|v| v.to_string())
        .ok_or("Missing user_id")?;

    let email = params
        .get("email")
        .map(|v| v.to_string())
        .ok_or("Missing email")?;

    let first_name = params.get("first_name").map(|v| v.to_string());
    let last_name = params.get("last_name").map(|v| v.to_string());

    // Create session from params
    let session = UserSession {
        sealed_session,
        user_id: user_id.clone(),
        email: email.clone(),
        first_name: first_name.clone(),
        last_name: last_name.clone(),
    };

    // Store session securely
    if let Err(e) = save_session(&session) {
        eprintln!("Failed to save session: {}", e);
        let _ = app.emit("auth-error", format!("Failed to save session: {}", e));
        return Err(format!("Failed to save session: {}", e).into());
    }

    println!("Auth callback received for user: {}", email);

    // Notify frontend of successful login
    let _ = app.emit("auth-success", serde_json::json!({
        "user": {
            "id": user_id,
            "email": email,
            "first_name": first_name,
            "last_name": last_name,
        }
    }));

    println!("auth-success event emitted");

    // Bring window to foreground
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        let _ = window.show();
        println!("Window focused");
    } else {
        eprintln!("Could not find main window to focus");
    }

    Ok(())
}

/// Save session to system keychain
pub fn save_session(session: &UserSession) -> Result<(), Box<dyn std::error::Error>> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    let json = serde_json::to_string(session)?;
    entry.set_password(&json)?;
    Ok(())
}

/// Get session from system keychain
pub fn get_session() -> Result<Option<UserSession>, Box<dyn std::error::Error>> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    match entry.get_password() {
        Ok(json) => {
            let session: UserSession = serde_json::from_str(&json)?;
            Ok(Some(session))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Box::new(e)),
    }
}

/// Clear session from system keychain
pub fn clear_session() -> Result<(), Box<dyn std::error::Error>> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already cleared
        Err(e) => Err(Box::new(e)),
    }
}
