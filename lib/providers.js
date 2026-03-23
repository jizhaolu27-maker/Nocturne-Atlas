const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");

function createProviderTools({
  CONFIG_DIR,
  readJson,
  writeJson,
  loadProviders,
  summarizeText,
}) {
  function getAppSecret() {
    const filePath = `${CONFIG_DIR}\\app-secret.json`;
    const current = readJson(filePath);
    if (current?.secret) {
      return current.secret;
    }
    const secret = crypto.randomBytes(32).toString("hex");
    writeJson(filePath, { secret, createdAt: new Date().toISOString() });
    return secret;
  }

  function getEncryptionKey() {
    const seed = `${os.hostname()}|${os.userInfo().username}|${getAppSecret()}`;
    return crypto.createHash("sha256").update(seed).digest();
  }

  function runPowerShell(command, args = []) {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command, ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  }

  function encryptSecretDpapi(value) {
    const plainB64 = Buffer.from(String(value), "utf8").toString("base64");
    const blob = runPowerShell(
      "$plain=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])); " +
        "$secure=ConvertTo-SecureString $plain -AsPlainText -Force; " +
        "ConvertFrom-SecureString $secure",
      [plainB64]
    );
    return {
      scheme: "windows-dpapi-powershell",
      blob,
      createdAt: new Date().toISOString(),
    };
  }

  function decryptSecretDpapi(payload) {
    if (!payload?.blob) {
      return "";
    }
    try {
      const out = runPowerShell(
        "$secure=ConvertTo-SecureString $args[0]; " +
          "$plain=[System.Net.NetworkCredential]::new('', $secure).Password; " +
          "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))",
        [payload.blob]
      );
      return Buffer.from(out, "base64").toString("utf8");
    } catch {
      return "";
    }
  }

  function encryptSecretLegacy(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      scheme: "legacy-aes-gcm",
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: encrypted.toString("hex"),
    };
  }

  function decryptSecretLegacy(payload) {
    if (!payload?.data || !payload?.iv || !payload?.tag) {
      return "";
    }
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getEncryptionKey(),
        Buffer.from(payload.iv, "hex")
      );
      decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload.data, "hex")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      return "";
    }
  }

  function encryptSecret(value) {
    try {
      return encryptSecretDpapi(value);
    } catch {
      return encryptSecretLegacy(value);
    }
  }

  function decryptSecret(payload) {
    if (!payload) {
      return "";
    }
    if (payload.scheme === "windows-dpapi-powershell") {
      return decryptSecretDpapi(payload);
    }
    return decryptSecretLegacy(payload);
  }

  function canDecryptSecret(payload) {
    return Boolean(decryptSecret(payload));
  }

  function getProviderForStory(story) {
    const providers = loadProviders();
    return providers.find((item) => item.id === story.providerId) || null;
  }

  function normalizeReasoningEffort(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return ["minimal", "low", "medium", "high"].includes(normalized) ? normalized : "";
  }

  function buildEndpointUrl(baseUrl, suffix) {
    const trimmedBase = String(baseUrl || "").trim();
    if (!trimmedBase) {
      throw new Error("Provider base URL is required");
    }
    const normalizedBase = trimmedBase.replace(/\/+$/, "");
    const normalizedSuffix = String(suffix || "").replace(/^\/+/, "");
    if (/\/chat\/completions$/i.test(normalizedBase)) {
      return normalizedBase;
    }
    return `${normalizedBase}/${normalizedSuffix}`;
  }

  async function sendChatCompletionsRequest(url, headers, payload, { allowCompatFallback = true } = {}) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok) {
      return { response, json };
    }

    const errorMessage = String(json?.error?.message || "");
    const canRetryCompat =
      allowCompatFallback &&
      (Object.prototype.hasOwnProperty.call(payload, "max_completion_tokens") ||
        Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) &&
      /max_completion_tokens|reasoning_effort|unknown parameter|additional properties|not permitted|extra fields?/i.test(errorMessage);

    if (!canRetryCompat) {
      throw new Error(errorMessage || `Provider error ${response.status}`);
    }

    const fallbackPayload = { ...payload };
    if (fallbackPayload.max_completion_tokens != null) {
      fallbackPayload.max_tokens = fallbackPayload.max_completion_tokens;
      delete fallbackPayload.max_completion_tokens;
    }
    delete fallbackPayload.reasoning_effort;

    const fallbackResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(fallbackPayload),
    });
    const fallbackJson = await fallbackResponse.json().catch(() => ({}));
    if (!fallbackResponse.ok) {
      throw new Error(fallbackJson?.error?.message || `Provider error ${fallbackResponse.status}`);
    }
    return { response: fallbackResponse, json: fallbackJson };
  }

  async function callOpenAICompatible({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    topP,
    max_tokens,
    reasoningEffort,
    responseFormat,
  }) {
    const url = buildEndpointUrl(baseUrl, "chat/completions");
    const payload = {
      model,
      messages,
      temperature,
      top_p: topP,
      max_completion_tokens: max_tokens,
      stream: false,
    };
    const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
    if (normalizedReasoningEffort) {
      payload.reasoning_effort = normalizedReasoningEffort;
    }
    if (responseFormat) {
      payload.response_format = responseFormat;
    }
    const startedAt = Date.now();
    const { response, json } = await sendChatCompletionsRequest(
      url,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      payload
    );
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Provider returned empty content");
    }
    return {
      content,
      raw: json,
      meta: {
        endpoint: url,
        latencyMs: Date.now() - startedAt,
        status: response.status,
        promptMessages: messages.length,
      },
    };
  }

  async function streamOpenAICompatible({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    topP,
    max_tokens,
    reasoningEffort,
    signal,
  }) {
    const url = buildEndpointUrl(baseUrl, "chat/completions");
    const payload = {
      model,
      messages,
      temperature,
      top_p: topP,
      max_completion_tokens: max_tokens,
      stream: true,
    };
    const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
    if (normalizedReasoningEffort) {
      payload.reasoning_effort = normalizedReasoningEffort;
    }
    const startedAt = Date.now();
    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      const errorMessage = String(json?.error?.message || "");
      const canRetryCompat =
        (Object.prototype.hasOwnProperty.call(payload, "max_completion_tokens") ||
          Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) &&
        /max_completion_tokens|reasoning_effort|unknown parameter|additional properties|not permitted|extra fields?/i.test(errorMessage);
      if (!canRetryCompat) {
        throw new Error(errorMessage || `Provider error ${response.status}`);
      }
      const fallbackPayload = { ...payload };
      if (fallbackPayload.max_completion_tokens != null) {
        fallbackPayload.max_tokens = fallbackPayload.max_completion_tokens;
        delete fallbackPayload.max_completion_tokens;
      }
      delete fallbackPayload.reasoning_effort;
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(fallbackPayload),
        signal,
      });
      if (!response.ok) {
        const fallbackJson = await response.json().catch(() => ({}));
        throw new Error(fallbackJson?.error?.message || `Provider error ${response.status}`);
      }
    }
    if (!response.body) {
      throw new Error("Provider streaming body is unavailable");
    }
    return {
      endpoint: url,
      startedAt,
      stream: response.body,
    };
  }

  async function testProviderConnection(provider, overrideModel) {
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      return {
        ok: false,
        stage: "local",
        error: "Stored API key cannot be decrypted on this machine. Re-enter and save the key.",
      };
    }
    try {
      const result = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: overrideModel || provider.model,
        messages: [
          { role: "system", content: "Reply with exactly: OK" },
          { role: "user", content: "connection test" },
        ],
        temperature: 0,
        topP: 1,
        max_tokens: 16,
      });
      return {
        ok: true,
        stage: "remote",
        replyPreview: summarizeText(result.content, 80),
        endpoint: result.meta.endpoint,
        latencyMs: result.meta.latencyMs,
      };
    } catch (error) {
      return {
        ok: false,
        stage: "remote",
        error: error.message || "Provider request failed",
      };
    }
  }

  return {
    encryptSecret,
    decryptSecret,
    canDecryptSecret,
    getProviderForStory,
    buildEndpointUrl,
    callOpenAICompatible,
    streamOpenAICompatible,
    testProviderConnection,
  };
}

module.exports = {
  createProviderTools,
};
