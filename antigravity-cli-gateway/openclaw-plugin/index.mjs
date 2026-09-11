// OpenClaw plugin: registers the "antigravity" web_search provider, backed by
// the local Antigravity websearch service (websearch-service.mjs in the
// gateway-stack deployment). The service returns gemini-provider-shaped
// payloads, so this plugin is a thin pass-through: forward the tool args,
// return the payload verbatim, and let the core web_search boundary do its
// normal answer-shape normalization.

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    country: { type: "string", description: "Not supported by Antigravity search." },
    language: { type: "string", description: "Not supported by Antigravity search." },
    freshness: {
      type: "string",
      description:
        "Filter search freshness: day prioritizes the last 24 hours as a recency hint; week, month, and year restrict results with a time-range instruction.",
    },
    date_after: {
      type: "string",
      description: "Only ground with results published after this date (YYYY-MM-DD).",
    },
    date_before: {
      type: "string",
      description: "Only ground with results published before this date (YYYY-MM-DD).",
    },
  },
  required: ["query"],
};

function resolveConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim()
    ? config.baseUrl.replace(/\/+$/, "")
    : "http://127.0.0.1:4570";
  const timeoutSeconds = Number.isSafeInteger(config.timeoutSeconds) && config.timeoutSeconds >= 5 && config.timeoutSeconds <= 240
    ? config.timeoutSeconds
    : 120;
  return { baseUrl, timeoutSeconds };
}

function createToolDefinition(searchConfig) {
  const { baseUrl, timeoutSeconds } = resolveConfig(searchConfig);
  return {
    description:
      "Search the web using Google Search grounding through the Antigravity subscription. Returns AI-synthesized answers with citations from Google Search.",
    parameters: TOOL_PARAMETERS,
    execute: async (args, context) => {
      context?.signal?.throwIfAborted();
      let response;
      try {
        response = await fetch(`${baseUrl}/v1/web-search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: context?.signal ?? AbortSignal.timeout(timeoutSeconds * 1000),
        });
      } catch (error) {
        if (context?.signal?.aborted) throw error;
        throw new Error(
          `Antigravity web search service is unreachable at ${baseUrl}: ${error?.message ?? error}. Start it with launchctl kickstart -k gui/$UID/ai.openclaw.antigravity-websearch`,
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`Antigravity web search service returned a non-JSON reply (HTTP ${response.status}).`);
      }
      // The service speaks the provider payload contract directly: valid
      // results (content + citations) pass through verbatim; {error,...}
      // objects pass through so the core boundary reports the provider code.
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
      throw new Error("Antigravity web search service returned an unexpected payload shape.");
    },
  };
}

export function createPluginDefinition() {
  return {
    id: "antigravity-web-search",
    name: "Antigravity Web Search",
    description:
      "web_search provider backed by the local Antigravity websearch service (agy subscription-grounded Google Search).",
    register(api) {
      api.registerWebSearchProvider({
        id: "antigravity",
        label: "Antigravity Search",
        hint: "Subscription-grounded Google Search through the local Antigravity CLI service. No API key needed.",
        requiresCredential: false,
        envVars: [],
        placeholder: "",
        signupUrl: "",
        credentialPath: "",
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
        createTool: () => createToolDefinition(api.pluginConfig),
      });
    },
  };
}

export default createPluginDefinition();
