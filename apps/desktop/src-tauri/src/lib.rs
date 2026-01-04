//! Addie App - Tauri backend (Desktop + Mobile)
//!
//! Handles:
//! - OAuth deep link authentication (addie://auth/callback)
//! - Secure session storage via system keychain
//! - API communication with AgenticAdvertising.org

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

mod auth;

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
async fn start_login(app: AppHandle) -> Result<(), String> {
    auth::start_oauth_flow(&app).map_err(|e| e.to_string())
}

/// Log out - clear stored session
#[tauri::command]
async fn logout() -> Result<(), String> {
    auth::clear_session().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Register deep link handler for OAuth callback
            let handle = app.handle().clone();

            {
                use tauri_plugin_deep_link::DeepLinkExt;

                println!("Setting up deep link handler...");

                // Check if app was launched via deep link (covers cold start case)
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    println!("App launched with deep link URLs: {:?}", urls);
                    for url in urls {
                        println!("Processing startup URL: {}", url.as_str());
                        if let Err(e) = auth::handle_deep_link(&handle, url.as_str()) {
                            eprintln!("Failed to handle startup deep link: {}", e);
                        }
                    }
                }

                // Handle deep links while app is running
                let handle_clone = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    println!("Deep link received while running!");
                    let urls = event.urls();
                    println!("URLs: {:?}", urls);
                    for url in urls {
                        println!("Processing URL: {}", url.as_str());
                        if let Err(e) = auth::handle_deep_link(&handle_clone, url.as_str()) {
                            eprintln!("Failed to handle deep link: {}", e);
                        }
                    }
                });

                println!("Deep link handler registered");
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
