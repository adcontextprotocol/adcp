//! Addie App - Tauri backend (Desktop + Mobile)
//!
//! Handles:
//! - State- and PKCE-bound OAuth deep link authentication
//! - Secure session storage via system keychain
//! - API communication with AgenticAdvertising.org

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

mod auth;
mod auth_flow;

#[derive(Default)]
pub struct AuthRuntime {
    flow_lock: tokio::sync::Mutex<()>,
}

/// User session data stored securely
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSession {
    pub sealed_session: String,
    pub user_id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

/// Auth state for the frontend
#[derive(Debug, Clone, Serialize)]
pub struct AuthState {
    pub is_authenticated: bool,
    pub user: Option<UserInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserInfo {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

/// Get current authentication state
#[tauri::command]
async fn get_auth_state() -> Result<AuthState, String> {
    match auth::get_session() {
        Ok(Some(session)) => Ok(AuthState {
            is_authenticated: true,
            user: Some(UserInfo {
                id: session.user_id,
                email: session.email,
                first_name: session.first_name,
                last_name: session.last_name,
            }),
        }),
        Ok(None) => Ok(AuthState {
            is_authenticated: false,
            user: None,
        }),
        Err(e) => Err(format!("Failed to get auth state: {}", e)),
    }
}

/// Get the sealed session token for API calls
#[tauri::command]
async fn get_session_token() -> Result<Option<String>, String> {
    match auth::get_session() {
        Ok(Some(session)) => Ok(Some(session.sealed_session)),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Failed to get session: {}", e)),
    }
}

/// Start OAuth login flow - opens system browser
#[tauri::command]
async fn start_login(app: AppHandle, runtime: State<'_, AuthRuntime>) -> Result<(), String> {
    auth::start_oauth_flow(&app, &runtime)
        .await
        .map_err(|_| "Failed to start authentication".to_string())
}

/// Log out - clear stored session
#[tauri::command]
async fn logout(runtime: State<'_, AuthRuntime>) -> Result<(), String> {
    let _guard = runtime.flow_lock.lock().await;
    auth::clear_session().map_err(|e| e.to_string())
}

fn dispatch_deep_link(app: AppHandle, raw_url: String) {
    tauri::async_runtime::spawn(async move {
        let runtime = app.state::<AuthRuntime>();
        if auth::handle_deep_link(&app, &runtime, &raw_url)
            .await
            .is_err()
        {
            let _ = tauri::Emitter::emit(&app, "auth-error", "authentication_failed");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Deep links on Windows and Linux may launch a second process. This
        // plugin must be registered first so the URL is forwarded to the
        // primary process before any auth handler runs.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(AuthRuntime::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Register deep link handler for OAuth callback
            let handle = app.handle().clone();

            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Check if app was launched via deep link (covers cold start case)
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        dispatch_deep_link(handle.clone(), url.as_str().to_string());
                    }
                }

                // Handle deep links while app is running
                let handle_clone = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        dispatch_deep_link(handle_clone.clone(), url.as_str().to_string());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_auth_state,
            get_session_token,
            start_login,
            logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
