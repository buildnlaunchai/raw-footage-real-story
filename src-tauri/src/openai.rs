//! OpenAI as an optional cloud provider for script generation.
//!
//! The key comes from the signed-in account and nowhere else; see
//! [`crate::provider_keys`].
//!
//! Uses the **Responses API**, which is current; Chat Completions is legacy.
//! Structured output goes in `text.format` with `strict: true` rather than the
//! older `response_format`.
//!
//! Like the ElevenLabs client, the call lives in Rust so the key never crosses
//! into JavaScript.

use serde::Serialize;
use std::time::Duration;

/// A frontier model writing a few hundred words is not fast, and a 300-clip
/// selection run is many calls; this only guards against a hung connection.
/// How long to wait when the caller has no opinion.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Never wait less than this, however small the job looks.
const MIN_TIMEOUT_SECS: u64 = 180;
/// Never wait longer than this, however large. Past a quarter of an hour
/// something has gone wrong that waiting will not fix.
const MAX_TIMEOUT_SECS: u64 = 900;

/// The wait a request of this size deserves.
///
/// A flat three minutes was fine for a title and far too short for a script:
/// fifteen hundred words of Bengali is five thousand output tokens or more
/// before the model has thought about anything, and these are reasoning
/// models. The request died at three minutes, having very likely been
/// generated and billed on the other end.
///
/// The whole response arrives at once — nothing streams — so this is a ceiling
/// on the total, not on silence between bytes.
fn timeout_for(words: Option<u32>) -> Duration {
    let Some(w) = words else { return REQUEST_TIMEOUT };
    let secs = 60 + (u64::from(w) * 3) / 10;
    Duration::from_secs(secs.clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiError {
    pub code: String,
    pub message: String,
    /// Where to send the browser to fix this, exactly as the platform
    /// addressed it.
    ///
    /// Carried on the error rather than pieced together in the UI, because
    /// nothing outside the response can know it: the destination follows the
    /// reason the key was withheld, and one of the three is a page with no
    /// provider in its address at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_url: Option<String>,
    /// What to put on the button that opens it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_label: Option<&'static str>,
}

impl OpenAiError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), consent_url: None, action_label: None }
    }

    fn from_key_problem(p: crate::provider_keys::KeyProblem) -> Self {
        Self {
            code: p.code().into(),
            message: p.message(),
            consent_url: p.consent_url(),
            action_label: p.action_label(),
        }
    }
}

/// Map a failure to something actionable.
///
/// The trap here mirrors the ElevenLabs 401: **rate limiting and billing
/// exhaustion are both 429**, and they mean opposite things — one is "wait a
/// moment", the other is "you need to pay". Classifying on the HTTP code alone
/// would tell someone out of credit to try again shortly, forever.
fn classify(status: u16, body: &str) -> OpenAiError {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let err_type = v["error"]["type"].as_str().unwrap_or("");
    let err_code = v["error"]["code"].as_str().unwrap_or("");
    let msg = v["error"]["message"].as_str().unwrap_or("");

    match (status, err_type, err_code) {
        (_, _, "credit_balance_exhausted") | (_, "insufficient_quota", _) => OpenAiError::new(
            "QUOTA_EXCEEDED",
            "Your OpenAI credit balance is exhausted. Add credit to continue.",
        ),
        (_, _, "organization_spend_limit_exceeded")
        | (_, _, "project_spend_limit_exceeded") => OpenAiError::new(
            "SPEND_LIMIT",
            "You've hit a spend limit set on your OpenAI account.",
        ),
        (401, _, _) => OpenAiError::new(
            "INVALID_API_KEY",
            "That API key was rejected. Check it in your OpenAI account.",
        ),
        (403, _, _) => OpenAiError::new(
            "FORBIDDEN",
            "Your OpenAI account doesn't have access to that model.",
        ),
        (404, _, _) => OpenAiError::new(
            "MODEL_NOT_FOUND",
            "That model isn't available on your OpenAI account.",
        ),
        (429, _, _) => OpenAiError::new(
            "RATE_LIMITED",
            "OpenAI is rate-limiting requests. Try again shortly.",
        ),
        // A rejected request is a bug on our side, not something the user can
        // act on, so it says what OpenAI objected to rather than "try again".
        (400, _, _) => OpenAiError::new(
            "INVALID_REQUEST",
            format!(
                "OpenAI rejected the request: {}",
                if msg.is_empty() { "no detail given".into() } else { msg.to_string() }
            ),
        ),
        (500..=599, _, _) => {
            OpenAiError::new("SERVICE_ERROR", "OpenAI had a server error. Try again shortly.")
        }
        _ => OpenAiError::new(
            "REQUEST_FAILED",
            format!(
                "OpenAI returned {status}: {}",
                if msg.is_empty() { body.chars().take(200).collect::<String>() } else { msg.to_string() }
            ),
        ),
    }
}

/// Adapt one of our JSON schemas to OpenAI's strict mode.
///
/// Strict mode is stricter than it sounds: every object must set
/// `additionalProperties: false` and list **every** property in `required`.
/// Our schemas were written for Ollama's constrained decoding, which requires
/// neither, so passing one through unchanged is rejected outright rather than
/// merely ignored.
pub fn to_strict_schema(schema: &serde_json::Value) -> serde_json::Value {
    let mut out = schema.clone();
    fn walk(node: &mut serde_json::Value) {
        if let Some(obj) = node.as_object_mut() {
            if obj.get("type").and_then(|t| t.as_str()) == Some("object") {
                obj.insert("additionalProperties".into(), serde_json::json!(false));
                if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
                    let names: Vec<String> = props.keys().cloned().collect();
                    obj.insert("required".into(), serde_json::json!(names));
                }
            }
            // minItems/maxItems are not supported by strict mode and cause a
            // schema rejection; the count is re-checked in code anyway.
            obj.remove("minItems");
            obj.remove("maxItems");
            let keys: Vec<String> = obj.keys().cloned().collect();
            for k in keys {
                if let Some(child) = obj.get_mut(&k) {
                    walk(child);
                }
            }
        } else if let Some(arr) = node.as_array_mut() {
            for child in arr {
                walk(child);
            }
        }
    }
    walk(&mut out);
    out
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiResult {
    pub text: String,
    pub usage: TokenUsage,
}

/// Where OpenAI is, when the MEMBER is paying. Lives here, with the client that
/// speaks to it, rather than in provider_keys — see the note on `target_for`.
const OPENAI_DIRECT: &str = "https://api.openai.com";

/// How long between polls. A script takes tens of seconds at least; asking more
/// often than this buys nothing and costs a request each time.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Per-request timeout. NOT the wait for the work — that is `timeout_for`, the
/// budget for the whole poll loop. Every individual request here is short: the
/// create returns an id immediately and a poll returns a status.
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// What the UI is told while it waits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateProgress {
    /// OpenAI's own word: `queued` or `in_progress`.
    pub status: String,
    pub elapsed_secs: u64,
    /// Whose key is paying, so the UI can say "your credits" when it is ours.
    pub mode: String,
}

/// One generation through the Responses API.
///
/// `app` is injected by Tauri and is invisible from JavaScript, so this command's
/// signature on the JS side is unchanged.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn openai_generate(
    app: tauri::AppHandle,
    model: String,
    prompt: String,
    system: Option<String>,
    format: Option<serde_json::Value>,
    temperature: Option<f32>,
    seed: Option<i64>,
    // Roughly how many words are being asked for, so the wait can match.
    words: Option<u32>,
) -> Result<OpenAiResult, OpenAiError> {
    generate(Some(app), model, prompt, system, format, temperature, seed, words).await
}

/// The command's body, with the AppHandle optional so it can be driven from a
/// test that has no Tauri runtime.
#[allow(clippy::too_many_arguments)]
async fn generate(
    app: Option<tauri::AppHandle>,
    model: String,
    prompt: String,
    system: Option<String>,
    format: Option<serde_json::Value>,
    temperature: Option<f32>,
    seed: Option<i64>,
    words: Option<u32>,
) -> Result<OpenAiResult, OpenAiError> {
    let target = crate::provider_keys::target_for(
        crate::provider_keys::Provider::OpenAi,
        OPENAI_DIRECT,
    )
    .await
        .map_err(OpenAiError::from_key_problem)?;
    generate_with_target(app, target, model, prompt, system, format, temperature, seed, words).await
}

/// The request itself, with the destination handed in rather than looked up.
///
/// Because this takes a resolved `CallTarget` and not an option, a call with no
/// credential cannot reach the network: the only callers resolve one first. The
/// guard is enforced by the signature, exactly as it was when this took a bare
/// key — splitting the lookup out is what makes the missing-credential case
/// testable without arranging for the machine to have no key.
///
/// ─── BACKGROUND MODE, ON BOTH PATHS ─────────────────────────────────────────
///
/// This used to be one blocking POST with a timeout of up to fifteen minutes.
/// It cannot stay that way, because in credit mode the hub's gateway FORCES
/// `background: true` — a synchronous Responses call would hold an Edge Function
/// open for the length of the generation and die at the platform's wall clock.
///
/// So the request is made in background mode on BOTH paths, not just through the
/// gateway. One code path is the reason: the alternative is a blocking call for
/// BYOK and a polled one for credit, two shapes for one feature, and the shape
/// that gets exercised less is the one that breaks. It costs a BYOK user nothing
/// — OpenAI supports background mode on a direct call too — and it buys them the
/// same thing it buys everyone else: the fifteen-minute ceiling stops being a
/// limit on how long the MODEL may think and becomes a limit on how long WE are
/// willing to wait, which is a much cheaper thing to run out of.
#[allow(clippy::too_many_arguments)]
async fn generate_with_target(
    app: Option<tauri::AppHandle>,
    target: crate::provider_keys::CallTarget,
    model: String,
    prompt: String,
    system: Option<String>,
    format: Option<serde_json::Value>,
    temperature: Option<f32>,
    seed: Option<i64>,
    words: Option<u32>,
) -> Result<OpenAiResult, OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| OpenAiError::new("CLIENT_INIT", e.to_string()))?;

    let mut input = Vec::new();
    if let Some(sys) = system {
        input.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    input.push(serde_json::json!({ "role": "user", "content": prompt }));

    let mut body = serde_json::json!({ "model": model, "input": input, "background": true });

    if let Some(schema) = format {
        body["text"] = serde_json::json!({
            "format": {
                "type": "json_schema",
                "name": "script_output",
                "schema": to_strict_schema(&schema),
                "strict": true
            }
        });
    }
    // Measured against gpt-5.6-terra, one parameter at a time:
    //
    //   neither          -> accepted
    //   temperature only -> 400 "Unsupported parameter: 'temperature'"
    //   seed only        -> 400 "Unknown parameter: 'seed'"
    //
    // Note the two messages differ. `temperature` exists but this model family
    // rejects it; `seed` is not a Responses API parameter at all. Neither is
    // silently ignored, so sending either fails the whole request.
    //
    // They stay in the signature so `openai_probe_sampling` can keep asking —
    // if a future model accepts them, the probe will say so — but callers pass
    // None and the capability is declared on the provider rather than assumed.
    if let Some(t) = temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(s) = seed {
        body["seed"] = serde_json::json!(s);
    }

    let created = send(&client, &target, reqwest::Method::POST, "/v1/responses", Some(&body)).await?;

    let id = created
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            OpenAiError::new("BAD_RESPONSE", "OpenAI accepted the request without returning an id.")
        })?
        .to_string();

    // Already finished — small prompts sometimes come back complete on the
    // create. Nothing to poll for.
    if is_terminal(&created) {
        return finish(created);
    }

    let budget = timeout_for(words);
    let started = std::time::Instant::now();
    let mode = format!("{:?}", target.mode).to_lowercase();

    loop {
        if started.elapsed() >= budget {
            return Err(OpenAiError::new(
                "TIMEOUT",
                "OpenAI is still working on this after a long wait. A long script in a \
                 language that needs many tokens can outrun it — try a shorter one, or \
                 the faster model tier.",
            ));
        }

        tokio::time::sleep(POLL_INTERVAL).await;

        let path = format!("/v1/responses/{id}");
        let polled = send(&client, &target, reqwest::Method::GET, &path, None).await?;

        let status = polled.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if is_terminal(&polled) {
            return finish(polled);
        }

        // Best-effort, and never allowed to fail the run: a UI that missed one
        // tick shows a slightly stale word, which is not worth an error.
        if let Some(app) = app.as_ref() {
            use tauri::Emitter;
            let _ = app.emit(
                "openai:progress",
                GenerateProgress {
                    status: status.to_string(),
                    elapsed_secs: started.elapsed().as_secs(),
                    mode: mode.clone(),
                },
            );
        }
    }
}

/// True once OpenAI has stopped working on this, whatever the outcome.
fn is_terminal(v: &serde_json::Value) -> bool {
    !matches!(
        v.get("status").and_then(|s| s.as_str()).unwrap_or(""),
        "queued" | "in_progress"
    )
}

/// A terminal response, turned into a result or a reason.
fn finish(v: serde_json::Value) -> Result<OpenAiResult, OpenAiError> {
    match v.get("status").and_then(|s| s.as_str()).unwrap_or("") {
        "completed" => extract_output(&v),
        "incomplete" => {
            let why = v
                .get("incomplete_details")
                .and_then(|d| d.get("reason"))
                .and_then(|r| r.as_str())
                .unwrap_or("unknown");
            Err(OpenAiError::new(
                "INCOMPLETE",
                format!("OpenAI stopped before finishing ({why}). Try a shorter script."),
            ))
        }
        other => {
            // `failed` and `cancelled` both carry an error object worth showing.
            let msg = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("OpenAI could not complete this request.");
            let code = other.to_uppercase();
            Err(OpenAiError::new(&code, msg.to_string()))
        }
    }
}

/// One request to wherever this call is going, with its headers attached.
///
/// The single place a header is set, so "which credential goes with which
/// destination" is decided once — in provider_keys::target_for — and never
/// reassembled at a call site.
async fn send(
    client: &reqwest::Client,
    target: &crate::provider_keys::CallTarget,
    method: reqwest::Method,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, OpenAiError> {
    let mut req = client.request(method, format!("{}{}", target.base, path));
    for (name, value) in &target.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    if let Some(b) = body {
        req = req.json(b);
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            OpenAiError::new("TIMEOUT", "The request took too long. Try again.")
        } else if e.is_connect() {
            OpenAiError::new("NETWORK", "Couldn't reach OpenAI. Check your connection.")
        } else {
            OpenAiError::new("REQUEST_FAILED", e.to_string())
        }
    })?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify(status, &text));
    }

    serde_json::from_str(&text).map_err(|e| OpenAiError::new("BAD_RESPONSE", e.to_string()))
}

/// Pull the text out of a Responses payload, treating a refusal as its own
/// outcome.
///
/// A refusal would otherwise arrive as "no parseable JSON" and be swallowed by
/// the caller's fallback, leaving the user staring at an unchanged draft with
/// no explanation.
pub fn extract_output(json: &serde_json::Value) -> Result<OpenAiResult, OpenAiError> {
    let usage = TokenUsage {
        input_tokens: json["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: json["usage"]["output_tokens"].as_u64().unwrap_or(0),
        total_tokens: json["usage"]["total_tokens"].as_u64().unwrap_or(0),
    };

    let empty = vec![];
    let output = json["output"].as_array().unwrap_or(&empty);

    let mut text = String::new();
    for item in output {
        let content = item["content"].as_array().unwrap_or(&empty);
        for part in content {
            match part["type"].as_str() {
                Some("refusal") => {
                    let why = part["refusal"].as_str().unwrap_or("No reason given.");
                    return Err(OpenAiError::new(
                        "REFUSED",
                        format!("The model declined to write this. {why}"),
                    ));
                }
                Some("output_text") => {
                    if let Some(t) = part["text"].as_str() {
                        text.push_str(t);
                    }
                }
                _ => {}
            }
        }
    }

    // Some payloads expose a flattened convenience field.
    if text.is_empty() {
        if let Some(t) = json["output_text"].as_str() {
            text.push_str(t);
        }
    }

    if text.trim().is_empty() {
        return Err(OpenAiError::new(
            "EMPTY_RESPONSE",
            "OpenAI returned no text for that request.",
        ));
    }
    Ok(OpenAiResult { text, usage })
}

// `openai_test_key` was here. It took a key from the webview and tried it,
// which was the point when there was a field to paste one into. There is not:
// the key comes from the account, and the account is the only thing that can
// say whether it is good. A command that accepts a credential from JavaScript
// is a way back to the local path, so it goes with the field it served.


/// Does this model actually honour `temperature` and `seed`?
///
/// Reasoning-oriented models often ignore both, which would make our seeded
/// reproducibility silently meaningless. Rather than assume either way, this
/// asks the same question twice at temperature 0 with a fixed seed and reports
/// whether the answers match.
#[tauri::command]
pub async fn openai_probe_sampling(model: String) -> Result<serde_json::Value, OpenAiError> {
    let prompt = "Name one colour. Reply with the single word only.";
    let mut answers = Vec::new();
    let mut rejected: Option<String> = None;

    for _ in 0..2 {
        match generate(
            None,
            model.clone(),
            prompt.to_string(),
            None,
            None,
            Some(0.0),
            Some(7),
            // A one-word probe; the default wait is more than generous.
            None,
        )
        .await
        {
            Ok(r) => answers.push(r.text.trim().to_lowercase()),
            Err(e) => {
                // A model that rejects the parameters outright is the clearest
                // possible answer to the question.
                rejected = Some(format!("{}: {}", e.code, e.message));
                break;
            }
        }
    }

    Ok(serde_json::json!({
        "model": model,
        "rejectedParameters": rejected,
        "answers": answers,
        "deterministic": answers.len() == 2 && answers[0] == answers[1],
    }))
}

#[cfg(test)]
mod poll_tests {
    use super::*;

    fn status(s: &str) -> serde_json::Value {
        serde_json::json!({ "id": "resp_1", "status": s })
    }

    #[test]
    fn the_loop_keeps_waiting_only_while_openai_is_still_working() {
        for s in ["queued", "in_progress"] {
            assert!(!is_terminal(&status(s)), "{s} must keep the poll going");
        }
        for s in ["completed", "failed", "cancelled", "incomplete"] {
            assert!(is_terminal(&status(s)), "{s} must end the poll");
        }
        // A payload with no status at all ends it too. Spinning forever on a
        // shape we do not understand is the worse of the two failures.
        assert!(is_terminal(&serde_json::json!({ "id": "resp_1" })));
    }

    #[test]
    fn an_incomplete_response_says_why_rather_than_looking_like_a_crash() {
        let v = serde_json::json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" }
        });
        let e = finish(v).expect_err("incomplete is not a success");
        assert_eq!(e.code, "INCOMPLETE");
        assert!(e.message.contains("max_output_tokens"), "{}", e.message);
    }

    #[test]
    fn a_failure_carries_openais_own_sentence() {
        let v = serde_json::json!({
            "status": "failed",
            "error": { "message": "The model produced invalid content." }
        });
        let e = finish(v).expect_err("failed is not a success");
        assert_eq!(e.code, "FAILED");
        assert_eq!(e.message, "The model produced invalid content.");
    }

    #[test]
    fn a_terminal_response_with_no_error_object_still_says_something() {
        let e = finish(status("cancelled")).expect_err("cancelled is not a success");
        assert_eq!(e.code, "CANCELLED");
        assert!(!e.message.is_empty());
    }
}

mod tests {
    use super::*;

    fn code_for(status: u16, body: &str) -> String {
        classify(status, body).code
    }

    /// Both are 429 and they mean opposite things: wait, versus pay.
    #[test]
    fn rate_limiting_and_running_out_of_credit_are_told_apart() {
        assert_eq!(
            code_for(429, r#"{"error":{"type":"insufficient_quota","message":"..."}}"#),
            "QUOTA_EXCEEDED"
        );
        assert_eq!(
            code_for(429, r#"{"error":{"code":"credit_balance_exhausted"}}"#),
            "QUOTA_EXCEEDED"
        );
        assert_eq!(
            code_for(429, r#"{"error":{"code":"organization_spend_limit_exceeded"}}"#),
            "SPEND_LIMIT"
        );
        assert_eq!(
            code_for(429, r#"{"error":{"code":"project_spend_limit_exceeded"}}"#),
            "SPEND_LIMIT"
        );
        // A plain 429 with nothing else really is just rate limiting.
        assert_eq!(code_for(429, r#"{"error":{"type":"rate_limit_error"}}"#), "RATE_LIMITED");
    }

    /// A missing credential becomes a typed error the UI can act on — and now
    /// one that carries somewhere to go.
    ///
    /// Still a pure check, for the reasons two earlier attempts established:
    /// asserting `openai_generate` fails only held on a machine with no key and
    /// otherwise made a live billed call, and blanking the environment variable
    /// sent the old lookup through to the keychain, where it hung on the macOS
    /// permission prompt.
    ///
    /// What changed is the shape of the answer. There is no local key to add,
    /// so "MISSING_API_KEY" would be an instruction with nothing behind it; the
    /// error names the dashboard instead, and the UI renders a button from it.
    #[test]
    fn an_unlinked_key_returns_a_typed_error_with_somewhere_to_go() {
        let err = super::OpenAiError::from_key_problem(
            crate::provider_keys::KeyProblem::NotLinked {
                provider: crate::provider_keys::Provider::OpenAi,
                reason: Some(crate::platform::WithheldReason::ConsentRequired),
                consent_url: Some("https://buildnlaunchai.com/dashboard/keys/desktop".into()),
            },
        );
        assert_eq!(err.code, "KEY_NOT_LINKED");
        assert!(!err.message.is_empty(), "the error must carry a message for the UI");
        // Carried through byte for byte. This one is the reason the app stopped
        // composing addresses: it has no provider in it, so nothing built from
        // a provider slug could ever have arrived here.
        assert_eq!(
            err.consent_url.as_deref(),
            Some("https://buildnlaunchai.com/dashboard/keys/desktop"),
            "the button on that error has nowhere to go",
        );
        assert!(err.action_label.is_some(), "the button has no words on it");
    }

    #[test]
    fn other_statuses_map_sensibly() {
        assert_eq!(code_for(401, "{}"), "INVALID_API_KEY");
        assert_eq!(code_for(403, "{}"), "FORBIDDEN");
        assert_eq!(code_for(404, "{}"), "MODEL_NOT_FOUND");
        assert_eq!(code_for(503, "{}"), "SERVICE_ERROR");
        assert_eq!(code_for(418, "{}"), "REQUEST_FAILED");
    }

    /// A refusal must be its own outcome, not silence.
    #[test]
    fn a_refusal_is_surfaced_rather_than_swallowed() {
        let json = serde_json::json!({
            "output": [{
                "content": [{ "type": "refusal", "refusal": "I can't help with that." }]
            }],
            "usage": { "input_tokens": 10, "output_tokens": 5, "total_tokens": 15 }
        });
        let err = extract_output(&json).expect_err("a refusal is an error");
        assert_eq!(err.code, "REFUSED");
        assert!(err.message.contains("can't help"), "the reason should reach the user");
    }

    #[test]
    fn output_text_and_usage_are_extracted() {
        let json = serde_json::json!({
            "output": [{
                "content": [{ "type": "output_text", "text": "{\"lines\":[]}" }]
            }],
            "usage": { "input_tokens": 1200, "output_tokens": 340, "total_tokens": 1540 }
        });
        let r = extract_output(&json).expect("should parse");
        assert_eq!(r.text, "{\"lines\":[]}");
        assert_eq!(r.usage.input_tokens, 1200);
        assert_eq!(r.usage.output_tokens, 340);
        assert_eq!(r.usage.total_tokens, 1540);
    }

    #[test]
    fn an_empty_response_is_an_error_not_an_empty_script() {
        let json = serde_json::json!({ "output": [], "usage": {} });
        assert_eq!(extract_output(&json).unwrap_err().code, "EMPTY_RESPONSE");
    }

    /// Strict mode rejects schemas that Ollama accepts, so ours are adapted.
    #[test]
    fn schemas_are_adapted_for_strict_mode() {
        let ours = serde_json::json!({
            "type": "object",
            "properties": {
                "weaknesses": { "type": "array", "items": { "type": "string" } },
                "lines": {
                    "type": "array",
                    "minItems": 5,
                    "maxItems": 5,
                    "items": { "type": "string" }
                }
            },
            "required": ["lines"]
        });
        let strict = to_strict_schema(&ours);

        assert_eq!(strict["additionalProperties"], serde_json::json!(false));
        // Strict mode requires *every* property listed, not just the ones we
        // consider mandatory.
        let required: Vec<&str> =
            strict["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(required.contains(&"lines") && required.contains(&"weaknesses"));
        // minItems/maxItems are unsupported and would be rejected outright.
        assert!(strict["properties"]["lines"].get("minItems").is_none());
        assert!(strict["properties"]["lines"].get("maxItems").is_none());
    }

    #[test]
    fn nested_objects_are_made_strict_too() {
        let ours = serde_json::json!({
            "type": "object",
            "properties": {
                "lines": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "ref": { "type": "integer" }, "text": { "type": "string" } },
                        "required": ["ref"]
                    }
                }
            },
            "required": ["lines"]
        });
        let strict = to_strict_schema(&ours);
        let item = &strict["properties"]["lines"]["items"];
        assert_eq!(item["additionalProperties"], serde_json::json!(false));
        let required: Vec<&str> =
            item["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(required.contains(&"ref") && required.contains(&"text"));
    }
}

#[cfg(test)]
mod param_probe {
    use super::*;

    /// Which sampling parameters does this model actually accept?
    ///
    /// The plan flagged this as unknown. It turned out not to be silently
    /// ignored but rejected with a 400, so the answer matters for every call.
    /// Determined by asking, one parameter at a time.
    #[tokio::test]
    #[ignore = "needs a real API key"]
    async fn which_sampling_parameters_are_accepted() {
        if std::env::var("OPENAI_API_KEY").ok().filter(|v| !v.trim().is_empty()).is_none() {
            eprintln!("no key available; skipping");
            return;
        }
        let model = std::env::var("PROBE_MODEL").unwrap_or_else(|_| "gpt-5.6-terra".into());
        println!("\n  probing {model}\n");

        for (label, temp, seed) in [
            ("neither", None, None),
            ("temperature only", Some(0.7f32), None),
            ("seed only", None, Some(42i64)),
            ("both", Some(0.7), Some(42)),
        ] {
            let r = generate(
                None,
                model.clone(),
                "Reply with the single word: ok".into(),
                None,
                None,
                temp,
                seed,
                None,
            )
            .await;
            match r {
                Ok(v) => println!("    {label:<18} ACCEPTED  ({} tokens)", v.usage.total_tokens),
                Err(e) => println!("    {label:<18} REJECTED  {}: {}", e.code, e.message),
            }
        }
    }
}

#[cfg(test)]
mod comparison {
    /// Runs the Node comparison harness with the key from the environment.
    ///
    /// `OPENAI_API_KEY`, which is the one place a provider key comes from
    /// outside a signed-in session — the keychain no longer holds one.
    ///
    /// The key is handed to the child process in its environment, so it never
    /// reaches disk, a log, or a command line.
    #[test]
    #[ignore = "needs a real API key; makes billed calls"]
    fn ollama_vs_openai() {
        let Some(key) = std::env::var("OPENAI_API_KEY").ok().filter(|v| !v.trim().is_empty()) else {
            eprintln!("no key available; skipping");
            return;
        };
        let scratch = std::path::Path::new(
            "/private/tmp/claude-501/-Users-zahidrobeen-Documents-Work-BuildnLaunchAI---Apps-Raw-Footage-Real-Story/063e7b93-ca42-4ab7-9c7f-21152a8c2f57/scratchpad",
        );
        // Which harness to run; the comparison is the default.
        let script = std::env::var("HARNESS").unwrap_or_else(|_| "openai_compare.mjs".into());
        let out = std::process::Command::new("node")
            .arg(scratch.join(script))
            .current_dir(scratch)
            .env("OPENAI_API_KEY", key)
            .output()
            .expect("run harness");
        println!("{}", String::from_utf8_lossy(&out.stdout));
        if !out.status.success() {
            println!("--- stderr ---\n{}", String::from_utf8_lossy(&out.stderr));
        }
    }
}

#[cfg(test)]
mod timeout_tests {
    use super::*;

    /// The wait has to follow the size of the job.
    ///
    /// A flat three minutes was fine for a title and too short for a script:
    /// a fifteen-hundred-word Bengali script is five thousand output tokens
    /// or more before a reasoning model has thought about anything, and the
    /// request died having very likely been generated and billed already.
    #[test]
    fn a_longer_script_is_given_longer_to_arrive() {
        // A title, or anything else that names no length.
        assert_eq!(timeout_for(None), REQUEST_TIMEOUT);

        // Short jobs keep the floor rather than being rushed.
        assert_eq!(timeout_for(Some(100)).as_secs(), MIN_TIMEOUT_SECS);
        assert_eq!(timeout_for(Some(400)).as_secs(), MIN_TIMEOUT_SECS);

        // The length that failed: comfortably past the old flat ceiling.
        let long = timeout_for(Some(1_500)).as_secs();
        assert!(long > 180, "1500 words still gets the old three minutes: {long}s");
        assert_eq!(long, 510);

        // And a bound, because past a quarter of an hour something is wrong
        // that waiting will not fix.
        assert_eq!(timeout_for(Some(100_000)).as_secs(), MAX_TIMEOUT_SECS);

        // Never shorter for more work.
        let mut last = 0;
        for w in [0, 500, 1_000, 2_000, 5_000] {
            let secs = timeout_for(Some(w)).as_secs();
            assert!(secs >= last, "{w} words got less time than fewer words");
            last = secs;
        }
    }
}
