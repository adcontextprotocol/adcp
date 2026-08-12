use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use url::Url;

pub const PROTOCOL_VERSION: u8 = 2;
pub const CLIENT_ID: &str = "org.agenticadvertising.addie";
pub const REDIRECT_URI: &str = "org.agenticadvertising.addie:/auth/callback";
pub const PENDING_TTL_SECONDS: u64 = 10 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingLogin {
    pub state: String,
    pub code_verifier: String,
    pub api_origin: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Serialize)]
pub struct StartRequest<'a> {
    pub v: u8,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub state: &'a str,
    pub code_challenge: String,
    pub code_challenge_method: &'static str,
}

#[derive(Debug, Serialize)]
pub struct TokenRequest<'a> {
    pub v: u8,
    pub grant_type: &'static str,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub code: &'a str,
    pub state: &'a str,
    pub code_verifier: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallbackOutcome {
    Code { code: String },
    Error { code: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallbackError {
    NotAuthCallback,
    Malformed,
    DuplicateParameter,
    LegacyProtocol,
    StateMismatch,
    IssuerMismatch,
    Expired,
}

fn random_base64url(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

pub fn derive_s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn new_pending_login(api_origin: String, now: u64) -> PendingLogin {
    PendingLogin {
        state: random_base64url(32),
        code_verifier: random_base64url(32),
        api_origin,
        client_id: CLIENT_ID.to_string(),
        redirect_uri: REDIRECT_URI.to_string(),
        created_at: now,
        expires_at: now + PENDING_TTL_SECONDS,
    }
}

pub fn start_request(pending: &PendingLogin) -> StartRequest<'_> {
    StartRequest {
        v: PROTOCOL_VERSION,
        client_id: &pending.client_id,
        redirect_uri: &pending.redirect_uri,
        state: &pending.state,
        code_challenge: derive_s256_challenge(&pending.code_verifier),
        code_challenge_method: "S256",
    }
}

pub fn token_request<'a>(pending: &'a PendingLogin, code: &'a str) -> TokenRequest<'a> {
    TokenRequest {
        v: PROTOCOL_VERSION,
        grant_type: "authorization_code",
        client_id: &pending.client_id,
        redirect_uri: &pending.redirect_uri,
        code,
        state: &pending.state,
        code_verifier: &pending.code_verifier,
    }
}

fn is_base64url_32_bytes(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn pending_is_live(pending: &PendingLogin, now: u64) -> bool {
    pending.expires_at == pending.created_at.saturating_add(PENDING_TTL_SECONDS)
        && pending.created_at <= now.saturating_add(60)
        && now < pending.expires_at
}

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_control() {
            return false;
        }
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

pub fn validate_callback(
    raw_url: &str,
    pending: &PendingLogin,
    now: u64,
) -> Result<CallbackOutcome, CallbackError> {
    if raw_url.len() > 4096 {
        return Err(CallbackError::Malformed);
    }
    if pending.redirect_uri != REDIRECT_URI {
        return Err(CallbackError::NotAuthCallback);
    }
    let query = raw_url
        .strip_prefix(REDIRECT_URI)
        .and_then(|suffix| suffix.strip_prefix('?'))
        .ok_or(CallbackError::NotAuthCallback)?;
    if query.is_empty() || !has_valid_percent_encoding(query) {
        return Err(CallbackError::Malformed);
    }
    let parsed = Url::parse(raw_url).map_err(|_| CallbackError::Malformed)?;
    if parsed.scheme() != "org.agenticadvertising.addie"
        || parsed.host_str().is_some()
        || parsed.path() != "/auth/callback"
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err(CallbackError::NotAuthCallback);
    }

    let mut params = HashMap::new();
    for (key, value) in parsed.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(CallbackError::DuplicateParameter);
        }
    }
    if params.contains_key("sealed_session")
        || params.contains_key("user_id")
        || params.contains_key("email")
    {
        return Err(CallbackError::LegacyProtocol);
    }
    let allowed = ["v", "code", "error", "state", "iss"];
    if params.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(CallbackError::Malformed);
    }
    if params.get("v").map(String::as_str) != Some("2") {
        return Err(CallbackError::LegacyProtocol);
    }
    let state = params.get("state").ok_or(CallbackError::Malformed)?;
    if !is_base64url_32_bytes(state) || !constant_time_equal(state, &pending.state) {
        return Err(CallbackError::StateMismatch);
    }
    if !pending_is_live(pending, now) {
        return Err(CallbackError::Expired);
    }
    if params.get("iss") != Some(&pending.api_origin) {
        return Err(CallbackError::IssuerMismatch);
    }

    match (params.get("code"), params.get("error")) {
        (Some(code), None) if is_base64url_32_bytes(code) => {
            Ok(CallbackOutcome::Code { code: code.clone() })
        }
        (None, Some(error)) if matches!(error.as_str(), "access_denied" | "server_error") => {
            Ok(CallbackOutcome::Error {
                code: error.clone(),
            })
        }
        _ => Err(CallbackError::Malformed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> PendingLogin {
        PendingLogin {
            state: "s".repeat(43),
            code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string(),
            api_origin: "https://agenticadvertising.org".to_string(),
            client_id: CLIENT_ID.to_string(),
            redirect_uri: REDIRECT_URI.to_string(),
            created_at: 1_000,
            expires_at: 1_000 + PENDING_TTL_SECONDS,
        }
    }

    fn callback(state: &str) -> String {
        format!(
            "{REDIRECT_URI}?v=2&code={}&state={state}&iss=https%3A%2F%2Fagenticadvertising.org",
            "g".repeat(43),
        )
    }

    #[test]
    fn matches_rfc_7636_vector() {
        assert_eq!(
            derive_s256_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn accepts_exact_live_callback() {
        assert_eq!(
            validate_callback(&callback(&pending().state), &pending(), 1_001),
            Ok(CallbackOutcome::Code {
                code: "g".repeat(43)
            })
        );
    }

    #[test]
    fn accepts_only_supported_error_callbacks() {
        let value = pending();
        let access_denied = format!(
            "{REDIRECT_URI}?v=2&error=access_denied&state={}&iss={}",
            value.state, value.api_origin,
        );
        assert_eq!(
            validate_callback(&access_denied, &value, 1_001),
            Ok(CallbackOutcome::Error {
                code: "access_denied".to_string()
            })
        );

        let attacker_error = access_denied.replace("access_denied", "attacker_controlled");
        assert_eq!(
            validate_callback(&attacker_error, &value, 1_001),
            Err(CallbackError::Malformed)
        );
    }

    #[test]
    fn rejects_issuer_mismatch() {
        let value = pending();
        let wrong_issuer = callback(&value.state).replace(
            "https%3A%2F%2Fagenticadvertising.org",
            "https%3A%2F%2Fevil.example",
        );
        assert_eq!(
            validate_callback(&wrong_issuer, &value, 1_001),
            Err(CallbackError::IssuerMismatch)
        );
    }

    #[test]
    fn rejects_wrong_state_without_mutating_pending() {
        let value = pending();
        assert_eq!(
            validate_callback(&callback(&"x".repeat(43)), &value, 1_001),
            Err(CallbackError::StateMismatch)
        );
        assert_eq!(value.state, "s".repeat(43));
    }

    #[test]
    fn rejects_expiry_boundary_and_future_or_corrupt_timestamps() {
        let value = pending();
        assert_eq!(
            validate_callback(&callback(&value.state), &value, value.expires_at),
            Err(CallbackError::Expired)
        );
        let mut future = value.clone();
        future.created_at = 2_000;
        future.expires_at = 2_000 + PENDING_TTL_SECONDS;
        assert_eq!(
            validate_callback(&callback(&future.state), &future, 1_000),
            Err(CallbackError::Expired)
        );
        let mut corrupt = value.clone();
        corrupt.expires_at += 1;
        assert_eq!(
            validate_callback(&callback(&corrupt.state), &corrupt, 1_001),
            Err(CallbackError::Expired)
        );
    }

    #[test]
    fn rejects_legacy_bearer_and_identity_parameters() {
        let value = pending();
        let url = format!(
            "{REDIRECT_URI}?v=2&code={}&state={}&iss={}&sealed_session=secret&email=attacker%40example.com",
            "g".repeat(43),
            value.state,
            value.api_origin,
        );
        assert_eq!(
            validate_callback(&url, &value, 1_001),
            Err(CallbackError::LegacyProtocol)
        );
    }

    #[test]
    fn rejects_duplicate_fragment_extra_and_mixed_result_parameters() {
        let value = pending();
        for url in [
            format!("{}&state={}", callback(&value.state), value.state),
            format!("{}#state={}", callback(&value.state), value.state),
            format!("{}&extra=true", callback(&value.state)),
            format!("{}&error=server_error", callback(&value.state)),
        ] {
            assert!(validate_callback(&url, &value, 1_001).is_err());
        }
    }

    #[test]
    fn rejects_wrong_scheme_authority_and_path() {
        let value = pending();
        for url in [
            callback(&value.state).replacen(REDIRECT_URI, "addie://auth/callback", 1),
            callback(&value.state).replacen(
                REDIRECT_URI,
                "https://agenticadvertising.org/auth/callback",
                1,
            ),
            callback(&value.state).replacen("/auth/callback", "/auth/callback/evil", 1),
            callback(&value.state).replacen(
                REDIRECT_URI,
                "org.agenticadvertising.addie://auth/callback",
                1,
            ),
            callback(&value.state).replacen(
                REDIRECT_URI,
                "ORG.AGENTICADVERTISING.ADDIE:/auth/callback",
                1,
            ),
            callback(&value.state).replacen(
                REDIRECT_URI,
                "org.agenticadvertising.addie:/auth/../auth/callback",
                1,
            ),
            callback(&value.state).replacen(
                REDIRECT_URI,
                "org.agenticadvertising.addie:/auth/%63allback",
                1,
            ),
            callback(&value.state).replacen(
                REDIRECT_URI,
                "org.agenticadvertising.addie:\\auth\\callback",
                1,
            ),
        ] {
            assert_eq!(
                validate_callback(&url, &value, 1_001),
                Err(CallbackError::NotAuthCallback)
            );
        }
    }

    #[test]
    fn rejects_malformed_percent_encoding_and_oversized_callbacks() {
        let value = pending();
        for url in [
            callback(&value.state).replace("v=2", "v=%"),
            callback(&value.state).replace("v=2", "v=%2"),
            callback(&value.state).replace("v=2", "v=%GG"),
            format!("{}&padding={}", callback(&value.state), "x".repeat(4096)),
        ] {
            assert_eq!(
                validate_callback(&url, &value, 1_001),
                Err(CallbackError::Malformed)
            );
        }
    }

    #[test]
    fn generated_state_and_verifier_are_fresh_and_well_formed() {
        let first = new_pending_login("https://agenticadvertising.org".to_string(), 100);
        let second = new_pending_login("https://agenticadvertising.org".to_string(), 100);
        assert!(is_base64url_32_bytes(&first.state));
        assert!(is_base64url_32_bytes(&first.code_verifier));
        assert_ne!(first.state, second.state);
        assert_ne!(first.code_verifier, second.code_verifier);
    }
}
