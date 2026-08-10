//! OpenAI as an optional cloud provider for script generation (bring your own key).
//!
//! Uses the **Responses API**, which is current; Chat Completions is legacy.
//! Structured output goes in `text.format` with `strict: true` rather than the
//! older `response_format`.
//!
//! Like the ElevenLabs client, the call lives in Rust so the key never crosses
//! into JavaScript.

use serde::Serialize;
use std::time::Duration;

const API: &str = "https://api.openai.com/v1/responses";

/// A frontier model writing a few hundred words is not fast, and a 300-clip
/// selection run is many calls; this only guards against a hung connection.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Serialize)]
pub struct OpenAiError {
    pub code: String,
    pub message: String,
}

impl OpenAiError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
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

fn key_error() -> OpenAiError {
    OpenAiError::new("MISSING_API_KEY", "Add your OpenAI API key to use cloud script generation.")
}

fn key() -> Result<String, OpenAiError> {
    crate::secrets::get("openai").ok_or_else(key_error)
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

/// One generation through the Responses API.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn openai_generate(
    model: String,
    prompt: String,
    system: Option<String>,
    format: Option<serde_json::Value>,
    temperature: Option<f32>,
    seed: Option<i64>,
) -> Result<OpenAiResult, OpenAiError> {
    generate_with_key(key()?, model, prompt, system, format, temperature, seed).await
}

/// The request itself, with the credential handed in rather than looked up.
///
/// Because this takes `String` and not `Option<String>`, a missing key cannot
/// reach the network: the only caller is `openai_generate`, which resolves the
/// credential with `key()?` first. The guard is enforced by the signature.
///
/// Splitting the lookup out is what makes the missing-key guard testable. The
/// previous shape resolved the key internally, so the only way to test "no key"
/// was to arrange for the machine to have none — and once a real key existed,
/// that test made a live billed call and failed *because it succeeded*.
#[allow(clippy::too_many_arguments)]
async fn generate_with_key(
    api_key: String,
    model: String,
    prompt: String,
    system: Option<String>,
    format: Option<serde_json::Value>,
    temperature: Option<f32>,
    seed: Option<i64>,
) -> Result<OpenAiResult, OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| OpenAiError::new("CLIENT_INIT", e.to_string()))?;

    let mut input = Vec::new();
    if let Some(sys) = system {
        input.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    input.push(serde_json::json!({ "role": "user", "content": prompt }));

    let mut body = serde_json::json!({ "model": model, "input": input });

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

    let resp = client
        .post(API)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                OpenAiError::new("TIMEOUT", "OpenAI took too long to respond.")
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

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| OpenAiError::new("BAD_RESPONSE", e.to_string()))?;

    extract_output(&json)
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

/// Validate a key without storing it, and report what the account can see.
#[tauri::command]
pub async fn openai_test_key(api_key: String, model: String) -> Result<TokenUsage, OpenAiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| OpenAiError::new("CLIENT_INIT", e.to_string()))?;

    let resp = client
        .post(API)
        .bearer_auth(api_key.trim())
        .json(&serde_json::json!({
            "model": model,
            "input": [{ "role": "user", "content": "Reply with the single word: ok" }],
        }))
        .send()
        .await
        .map_err(|e| OpenAiError::new("NETWORK", e.to_string()))?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify(status, &text));
    }
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| OpenAiError::new("BAD_RESPONSE", e.to_string()))?;
    Ok(extract_output(&json)?.usage)
}

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
        match openai_generate(
            model.clone(),
            prompt.to_string(),
            None,
            None,
            Some(0.0),
            Some(7),
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

    /// A missing credential becomes a typed error the UI can act on.
    ///
    /// This is a pure check on purpose. Two earlier attempts were worse: the
    /// first asserted `openai_generate` failed, which only held while the
    /// machine had no key and otherwise made a live billed call; the second
    /// masked `OPENAI_API_KEY` with a blank value, which made `get()` fall
    /// through to the keychain and hang on the macOS permission prompt.
    #[test]
    fn missing_key_returns_a_typed_error() {
        let err = super::key_error();
        assert_eq!(err.code, "MISSING_API_KEY");
        assert!(!err.message.is_empty(), "the error must carry a message for the UI");
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
        if crate::secrets::get("openai").is_none() {
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
            let r = openai_generate(
                model.clone(),
                "Reply with the single word: ok".into(),
                None,
                None,
                temp,
                seed,
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
    /// Runs the Node comparison harness with the key from the keychain.
    ///
    /// The key is handed to the child process in its environment, so it never
    /// reaches disk, a log, or a command line.
    #[test]
    #[ignore = "needs a real API key; makes billed calls"]
    fn ollama_vs_openai() {
        let Some(key) = crate::secrets::get("openai") else {
            eprintln!("no key available; skipping");
            return;
        };
        let scratch = std::path::Path::new(
            "/private/tmp/claude-501/-Users-zahidrobeen-Documents-Work-BuildnLaunchAI---Apps-Raw-Footage-Real-Story/063e7b93-ca42-4ab7-9c7f-21152a8c2f57/scratchpad",
        );
        let out = std::process::Command::new("node")
            .arg(scratch.join("openai_compare.mjs"))
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
