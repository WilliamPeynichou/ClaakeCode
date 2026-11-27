// Fake model providers for the subscription tests: the Worker's PROVIDER_TEST_URL sends every upstream
// call to `http://127.0.0.1:<port>/<host><path>`. Tokens rotate on refresh, like the real services.
import http from "node:http";

const sse = (events) => events.map((e) => (e.event ? `event: ${e.event}\n` : "") + `data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

export function startFakeProviders(port) {
  const calls = [];
  // `expiresIn` lets a test make the next call refresh; `reject` makes the next model call fail once.
  const state = { expiresIn: 3600, reject: null, access: {}, refresh: {}, kimiPolls: 0, generation: {} };
  const issue = (provider) => {
    const n = (state.generation[provider] = (state.generation[provider] ?? 0) + 1);
    state.access[provider] = `${provider}-at-${n}`;
    state.refresh[provider] = `${provider}-rt-${n}`;
    return { access_token: state.access[provider], refresh_token: state.refresh[provider], expires_in: state.expiresIn };
  };
  const reply = (res, status, body, type = "application/json") =>
    res.writeHead(status, { "content-type": type }).end(typeof body === "string" ? body : JSON.stringify(body));
  const bearer = (req, provider) => req.headers.authorization === `Bearer ${state.access[provider]}`;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const path = url.pathname;
      const form = Object.fromEntries(new URLSearchParams(raw));
      let json = {};
      try {
        json = JSON.parse(raw);
      } catch {}
      calls.push({ method: req.method, path, headers: req.headers, json, form });
      const modelCall = (provider) => {
        if (state.reject && state.reject.provider === provider) {
          const { status } = state.reject;
          state.reject = null;
          reply(res, status, { error: { message: "refused by fake" } });
          return false;
        }
        if (!bearer(req, provider)) {
          reply(res, 401, { error: { message: "bad token" } });
          return false;
        }
        return true;
      };

      // Claude
      if (path === "/platform.claude.com/v1/oauth/token") {
        if (json.grant_type === "authorization_code" && json.code === "claude-code" && json.code_verifier && json.redirect_uri === "https://platform.claude.com/oauth/code/callback")
          return reply(res, 200, { ...issue("anthropic"), account: { email_address: "alice@example.com" } });
        if (json.grant_type === "refresh_token" && json.refresh_token === state.refresh.anthropic) return reply(res, 200, issue("anthropic"));
        return reply(res, 400, { error: "invalid_grant" });
      }
      if (path === "/api.anthropic.com/v1/messages") {
        if (!modelCall("anthropic")) return;
        const text = (json.messages.at(-1).content.find((p) => p.type === "text")?.text ?? "").includes("Résume") ? "Résumé de Claude : TOURNESOL-42." : "Bonjour de Claude.";
        return reply(res, 200, sse([
          { event: "message_start", data: { type: "message_start" } },
          ...text.match(/\S+\s*/g).map((t) => ({ event: "content_block_delta", data: { type: "content_block_delta", delta: { type: "text_delta", text: t } } })),
          { event: "message_stop", data: { type: "message_stop" } },
        ]), "text/event-stream");
      }

      // ChatGPT
      if (path === "/auth.openai.com/oauth/token") {
        const tokens = () => ({ ...issue("openai"), id_token: jwt({ email: "alice@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }) });
        if (form.grant_type === "authorization_code" && form.code === "oa-code" && form.code_verifier && form.redirect_uri === "http://localhost:1455/auth/callback") return reply(res, 200, tokens());
        if (form.grant_type === "refresh_token" && form.refresh_token === state.refresh.openai) return reply(res, 200, tokens());
        return reply(res, 400, { error: "invalid_grant" });
      }
      if (path === "/chatgpt.com/backend-api/codex/responses") {
        if (!modelCall("openai")) return;
        return reply(res, 200, sse(["Bonjour ", "de ChatGPT."].map((d) => ({ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: d } }))), "text/event-stream");
      }

      // Gemini (Antigravity)
      if (path === "/oauth2.googleapis.com/token") {
        if (form.client_secret !== "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") return reply(res, 401, { error: "invalid_client" });
        if (form.grant_type === "authorization_code" && form.code === "g-code") return reply(res, 200, issue("google"));
        if (form.grant_type === "refresh_token" && form.refresh_token === state.refresh.google) {
          const { refresh_token, ...rest } = issue("google");
          state.refresh.google = form.refresh_token; // Google keeps the refresh token
          return reply(res, 200, rest);
        }
        return reply(res, 400, { error: "invalid_grant" });
      }
      if (path === "/www.googleapis.com/oauth2/v2/userinfo") return bearer(req, "google") ? reply(res, 200, { email: "alice@gmail.com" }) : reply(res, 401, {});
      if (path === "/cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") return bearer(req, "google") ? reply(res, 200, { cloudaicompanionProject: "proj-42" }) : reply(res, 401, {});
      if (path === "/daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent") return reply(res, 403, { error: { message: "daily refused" } });
      if (path === "/cloudcode-pa.googleapis.com/v1internal:streamGenerateContent") {
        if (!modelCall("google")) return;
        return reply(res, 200, sse([
          { data: { response: { candidates: [{ content: { parts: [{ text: "Je réfléchis…", thought: true }] } }] } } },
          { data: { response: { candidates: [{ content: { parts: [{ text: "Bonjour " }] } }] } } },
          { data: { response: { candidates: [{ content: { parts: [{ text: "de Gemini." }] } }] } } },
        ]), "text/event-stream");
      }

      // Kimi
      if (path === "/auth.kimi.com/api/oauth/device_authorization") {
        state.kimiPolls = 0;
        return reply(res, 200, { user_code: "KIMI-1234", device_code: "dev-1", verification_uri_complete: "https://www.kimi.com/device?code=KIMI-1234", interval: 5 });
      }
      if (path === "/auth.kimi.com/api/oauth/token") {
        if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code" && form.device_code === "dev-1")
          return state.kimiPolls++ === 0 ? reply(res, 400, { error: "authorization_pending" }) : reply(res, 200, issue("kimi"));
        if (form.grant_type === "refresh_token" && form.refresh_token === state.refresh.kimi) return reply(res, 200, issue("kimi"));
        return reply(res, 400, { error: "invalid_grant" });
      }
      const chunks = (text) => sse([...text.match(/\S+\s*/g).map((t) => ({ data: { choices: [{ delta: { content: t } }] } })), { data: "[DONE]" }]);
      if (path === "/api.kimi.com/coding/v1/chat/completions") return modelCall("kimi") && reply(res, 200, chunks("Bonjour de Kimi."), "text/event-stream");

      // Mistral (API key)
      if (path === "/api.mistral.ai/v1/models") {
        if (req.headers.authorization !== "Bearer mistral-good") return reply(res, 401, { detail: "Unauthorized" });
        return reply(res, 200, { data: [
          { id: "mistral-large-latest", max_context_length: 128000, capabilities: { completion_chat: true, vision: true } },
          { id: "mistral-large-latest", max_context_length: 128000, capabilities: { completion_chat: true, vision: true } },
          { id: "mistral-large-2411", max_context_length: 128000, capabilities: { completion_chat: true } },
          { id: "mistral-embed", capabilities: { completion_chat: false } },
        ] });
      }
      if (path === "/api.mistral.ai/v1/chat/completions") {
        state.access.mistral = "mistral-good";
        return modelCall("mistral") && reply(res, 200, chunks("Bonjour de Mistral."), "text/event-stream");
      }
      reply(res, 404, { error: `fake: no route ${path}` });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, calls, state, close: () => server.close() })));
}
