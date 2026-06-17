import type {
  ProdAuthStatus,
  ProdCliStatus,
  ProdProviderDefinition,
  ProdProviderId,
  ProdProviderRuntimeStatus,
  ProdSettings,
} from "../types";

export const PROD_SETTINGS_CHANGED_EVENT = "claakecode:prod-settings-changed";

export const PROD_PROVIDERS: ProdProviderDefinition[] = [
  {
    id: "vercel",
    name: "Vercel",
    cli: "vercel",
    icon: "simple-icons:vercel",
    installUrl: "https://vercel.com/docs/cli",
    loginCommand: "vercel login",
    logoutCommand: "vercel logout",
    authCheckCommand: "vercel whoami",
    tokenEnvVar: "VERCEL_TOKEN",
    authModes: ["oauth", "token"],
    actions: [
      { id: "deploy-preview", label: "Deploy", command: "vercel", icon: "solar:rocket-linear" },
      {
        id: "deploy-prod",
        label: "Deploy prod",
        command: "vercel --prod",
        icon: "solar:rocket-2-linear",
        requiresConfirmation: true,
      },
      { id: "env", label: "Env", command: "vercel env", icon: "solar:key-minimalistic-linear" },
      { id: "logs", label: "Logs", command: "vercel logs", icon: "solar:document-text-linear" },
    ],
  },
  {
    id: "railway",
    name: "Railway",
    cli: "railway",
    icon: "simple-icons:railway",
    installUrl: "https://docs.railway.com/guides/cli",
    loginCommand: "railway login",
    logoutCommand: "railway logout",
    authCheckCommand: "railway whoami",
    tokenEnvVar: "RAILWAY_TOKEN",
    authModes: ["oauth", "token"],
    actions: [
      { id: "init", label: "Init", command: "railway init", icon: "solar:add-folder-linear" },
      { id: "link", label: "Link", command: "railway link", icon: "solar:link-round-linear" },
      { id: "up", label: "Deploy", command: "railway up", icon: "solar:rocket-linear" },
      { id: "logs", label: "Logs", command: "railway logs", icon: "solar:document-text-linear" },
    ],
  },
  {
    id: "netlify",
    name: "Netlify",
    cli: "netlify",
    icon: "simple-icons:netlify",
    installUrl: "https://docs.netlify.com/cli/get-started/",
    loginCommand: "netlify login",
    logoutCommand: "netlify logout",
    authCheckCommand: "netlify status",
    tokenEnvVar: "NETLIFY_AUTH_TOKEN",
    authModes: ["oauth", "token"],
    actions: [
      { id: "init", label: "Init", command: "netlify init", icon: "solar:add-folder-linear" },
      { id: "deploy", label: "Deploy", command: "netlify deploy", icon: "solar:rocket-linear" },
      {
        id: "deploy-prod",
        label: "Deploy prod",
        command: "netlify deploy --prod",
        icon: "solar:rocket-2-linear",
        requiresConfirmation: true,
      },
      { id: "dev", label: "Dev", command: "netlify dev", icon: "solar:code-square-linear" },
    ],
  },
  {
    id: "render",
    name: "Render",
    cli: "render",
    icon: "simple-icons:render",
    installUrl: "https://render.com/docs/cli",
    loginCommand: "render login",
    logoutCommand: "render logout",
    authCheckCommand: null,
    tokenEnvVar: "RENDER_API_KEY",
    authModes: ["oauth", "token"],
    actions: [
      { id: "services", label: "Services", command: "render services", icon: "solar:server-linear" },
      {
        id: "deploy",
        label: "Create deploy",
        command: "render deploys create",
        icon: "solar:rocket-linear",
      },
      { id: "logs", label: "Logs", command: "render logs", icon: "solar:document-text-linear" },
      { id: "ssh", label: "SSH", command: "render ssh", icon: "solar:login-3-linear" },
    ],
  },
  {
    id: "fly",
    name: "Fly.io",
    cli: "fly",
    cliAliases: ["flyctl"],
    icon: "simple-icons:flydotio",
    installUrl: "https://fly.io/docs/flyctl/install/",
    loginCommand: "fly auth login",
    logoutCommand: "fly auth logout",
    authCheckCommand: "fly auth whoami",
    tokenEnvVar: "FLY_API_TOKEN",
    authModes: ["oauth", "token"],
    actions: [
      { id: "launch", label: "Launch", command: "fly launch", icon: "solar:rocket-linear" },
      { id: "deploy", label: "Deploy", command: "fly deploy", icon: "solar:rocket-2-linear" },
      { id: "logs", label: "Logs", command: "fly logs", icon: "solar:document-text-linear" },
      { id: "ssh", label: "SSH", command: "fly ssh console", icon: "solar:login-3-linear" },
    ],
  },
  {
    id: "heroku",
    name: "Heroku",
    cli: "heroku",
    icon: "simple-icons:heroku",
    installUrl: "https://devcenter.heroku.com/articles/heroku-cli",
    loginCommand: "heroku login",
    logoutCommand: "heroku logout",
    authCheckCommand: "heroku auth:whoami",
    tokenEnvVar: "HEROKU_API_KEY",
    authModes: ["oauth", "token"],
    actions: [
      { id: "create", label: "Create", command: "heroku create", icon: "solar:add-circle-linear" },
      {
        id: "push-main",
        label: "Push main",
        command: "git push heroku main",
        icon: "solar:upload-linear",
        requiresConfirmation: true,
      },
      {
        id: "logs",
        label: "Logs tail",
        command: "heroku logs --tail",
        icon: "solar:document-text-linear",
      },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    cli: "wrangler",
    icon: "simple-icons:cloudflare",
    installUrl: "https://developers.cloudflare.com/workers/wrangler/install-and-update/",
    loginCommand: "wrangler login",
    logoutCommand: "wrangler logout",
    authCheckCommand: "wrangler whoami",
    tokenEnvVar: "CLOUDFLARE_API_TOKEN",
    authModes: ["oauth", "token"],
    actions: [
      { id: "dev", label: "Dev", command: "wrangler dev", icon: "solar:code-square-linear" },
      {
        id: "deploy",
        label: "Deploy",
        command: "wrangler deploy",
        icon: "solar:rocket-linear",
        requiresConfirmation: true,
      },
      {
        id: "pages-deploy",
        label: "Pages deploy",
        command: "wrangler pages deploy",
        icon: "solar:cloud-upload-linear",
        requiresConfirmation: true,
      },
    ],
  },
  {
    id: "supabase",
    name: "Supabase",
    cli: "supabase",
    icon: "simple-icons:supabase",
    installUrl: "https://supabase.com/docs/guides/cli/getting-started",
    loginCommand: "supabase login",
    logoutCommand: "supabase logout",
    authCheckCommand: "supabase projects list",
    tokenEnvVar: "SUPABASE_ACCESS_TOKEN",
    authModes: ["oauth", "token"],
    actions: [
      { id: "init", label: "Init", command: "supabase init", icon: "solar:add-folder-linear" },
      { id: "start", label: "Start", command: "supabase start", icon: "solar:play-linear" },
      {
        id: "db-push",
        label: "DB push",
        command: "supabase db push",
        icon: "solar:database-linear",
        requiresConfirmation: true,
      },
      {
        id: "functions-deploy",
        label: "Functions deploy",
        command: "supabase functions deploy",
        icon: "solar:cloud-upload-linear",
        requiresConfirmation: true,
      },
    ],
  },
];

export const PROD_PROVIDERS_MAP: Record<string, ProdProviderDefinition> = Object.fromEntries(
  PROD_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const EMPTY_PROD_SETTINGS: ProdSettings = { providers: [] };

export function normalizeProdProviderDefinitions(input: unknown): ProdProviderDefinition[] {
  if (!Array.isArray(input)) return PROD_PROVIDERS;
  const normalized = input
    .map(normalizeProdProviderDefinition)
    .filter((provider): provider is ProdProviderDefinition => provider !== null);
  return normalized.length > 0 ? normalized : PROD_PROVIDERS;
}

export function normalizeProdSettings(input: unknown): ProdSettings {
  if (Array.isArray(input)) {
    return {
      providers: input
        .map(normalizeProdProviderStatus)
        .filter((provider): provider is ProdProviderRuntimeStatus => provider !== null),
    };
  }
  if (isRecord(input)) {
    if (Array.isArray(input.providers)) {
      return {
        providers: input.providers
          .map(normalizeProdProviderStatus)
          .filter((provider): provider is ProdProviderRuntimeStatus => provider !== null),
      };
    }
    const single = normalizeProdProviderStatus(input);
    if (single) return { providers: [single] };
  }
  return EMPTY_PROD_SETTINGS;
}

export function mergeProdStatusResult(
  current: ProdSettings,
  result: unknown,
): ProdSettings {
  const normalized = normalizeProdSettings(result);
  if (normalized.providers.length === 0) return current;
  const byId = new Map(current.providers.map((provider) => [provider.providerId, provider]));
  for (const provider of normalized.providers) byId.set(provider.providerId, provider);
  return { providers: Array.from(byId.values()) };
}

export function prodStatusForProvider(
  settings: ProdSettings,
  providerId: ProdProviderId | string,
): ProdProviderRuntimeStatus {
  return (
    settings.providers.find((provider) => provider.providerId === providerId) ??
    defaultProdProviderStatus(providerId)
  );
}

export function defaultProdProviderStatus(providerId: ProdProviderId | string): ProdProviderRuntimeStatus {
  return {
    providerId,
    cliStatus: "unknown",
    authStatus: "unknown",
    identity: null,
    error: null,
    tokenConfigured: false,
    tokenPreview: null,
    lastCheckedMs: null,
  };
}

export function prodCliLabel(status: ProdCliStatus): string {
  switch (status) {
    case "checking":
      return "Checking CLI";
    case "installed":
      return "CLI installed";
    case "missing":
      return "CLI missing";
    case "error":
      return "CLI error";
    default:
      return "CLI unknown";
  }
}

export function prodCliTone(status: ProdCliStatus): "ok" | "pending" | "error" | "off" {
  switch (status) {
    case "installed":
      return "ok";
    case "checking":
      return "pending";
    case "missing":
    case "error":
      return "error";
    default:
      return "off";
  }
}

export function prodAuthLabel(status: ProdAuthStatus): string {
  switch (status) {
    case "checking":
      return "Checking auth";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Not connected";
    case "error":
      return "Auth error";
    default:
      return "Auth unknown";
  }
}

export function prodAuthTone(status: ProdAuthStatus): "ok" | "pending" | "error" | "off" {
  switch (status) {
    case "connected":
      return "ok";
    case "checking":
      return "pending";
    case "error":
      return "error";
    default:
      return "off";
  }
}

export function prodProviderDotTone(status: ProdProviderRuntimeStatus): "ok" | "pending" | "error" | "off" {
  if (status.authStatus === "connected") return "ok";
  if (status.authStatus === "checking" || status.cliStatus === "checking") return "pending";
  if (status.authStatus === "error" || status.cliStatus === "missing" || status.cliStatus === "error") {
    return "error";
  }
  return "off";
}

export function prodConnectedCount(settings: ProdSettings): number {
  return settings.providers.filter((provider) => provider.authStatus === "connected").length;
}

export function prodSettingsFingerprint(settings: ProdSettings): string {
  return JSON.stringify(
    [...settings.providers].sort((a, b) => a.providerId.localeCompare(b.providerId)),
  );
}

export function sanitizeProdMessage(message: string): string {
  return message
    .replace(/[A-Z0-9_]*(?:TOKEN|KEY|SECRET)[A-Z0-9_]*=([^\s]+)/gi, (match) => {
      const [name] = match.split("=");
      return `${name}=••••`;
    })
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1••••");
}

export function prodErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeProdMessage(message);
}

export function prodVisibleCommandHasSecret(command: string, tokenEnvVar?: string | null): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  const secretAssignmentPattern = /(?:^|\s)(?:export\s+)?[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|PWD|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=/i;
  const bearerPattern = /(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]+/i;
  const inlineSecretFlagPattern = /(?:^|\s)--(?:token|api-key|key|secret|password|auth-token)\b(?:\s+|=)\S+/i;
  const envReferencePattern = tokenEnvVar
    ? new RegExp(`(?:^|\\s)(?:env\\s+)?${escapeRegExp(tokenEnvVar)}\\s*=|\\$\\{?${escapeRegExp(tokenEnvVar)}\\}?`, "i")
    : null;
  return (
    secretAssignmentPattern.test(normalized) ||
    bearerPattern.test(normalized) ||
    inlineSecretFlagPattern.test(normalized) ||
    Boolean(envReferencePattern?.test(normalized))
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeProdProviderDefinition(input: unknown): ProdProviderDefinition | null {
  if (!isRecord(input)) return null;
  const id = stringValue(input.id);
  const name = stringValue(input.name);
  const cli = stringValue(input.cli ?? input.cliName ?? input.cli_name);
  const cliCandidates = arrayOfStrings(input.cliCandidates ?? input.cli_candidates);
  const cliAliases = arrayOfStrings(input.cliAliases ?? input.cli_aliases);
  const fallback = PROD_PROVIDERS.find((provider) => provider.id === id);
  if (!id || !name || (!cli && cliCandidates.length === 0 && cliAliases.length === 0 && !fallback?.cli)) return null;
  const primaryCli = cli || cliCandidates[0] || fallback?.cli || cliAliases[0] || "cli";
  const aliases = [...cliCandidates, ...cliAliases].filter((candidate) => candidate !== primaryCli);
  const authModes = arrayOfStrings(input.authModes ?? input.auth_modes).filter(
    (mode): mode is "oauth" | "token" => mode === "oauth" || mode === "token",
  );
  return {
    id,
    name,
    cli: primaryCli,
    cliName: stringValue(input.cliName ?? input.cli_name) || primaryCli,
    cliCandidates: cliCandidates.length > 0 ? cliCandidates : [primaryCli, ...aliases],
    cliAliases: aliases,
    icon: stringValue(input.icon) || fallback?.icon || "solar:cloud-linear",
    installUrl: stringValue(input.installUrl ?? input.install_url) || fallback?.installUrl || "",
    loginCommand:
      stringValue(input.loginCommand ?? input.login_command ?? input.loginLabel ?? input.login_label) ||
      fallback?.loginCommand ||
      `${primaryCli} login`,
    loginLabel: nullableString(input.loginLabel ?? input.login_label),
    logoutCommand: nullableString(input.logoutCommand ?? input.logout_command ?? fallback?.logoutCommand),
    authCheckCommand: nullableString(
      input.authCheckCommand ?? input.auth_check_command ?? input.authCheckLabel ?? input.auth_check_label ?? fallback?.authCheckCommand,
    ),
    authCheckLabel: nullableString(input.authCheckLabel ?? input.auth_check_label),
    tokenEnvVar: nullableString(input.tokenEnvVar ?? input.token_env_var ?? fallback?.tokenEnvVar),
    authModes: authModes.length > 0 ? authModes : fallback?.authModes ?? ["oauth"],
    actions: normalizeActions(input.actions, fallback?.actions ?? []),
  };
}

function normalizeActions(input: unknown, fallback: ProdProviderDefinition["actions"]): ProdProviderDefinition["actions"] {
  if (!Array.isArray(input)) return fallback;
  const actions: ProdProviderDefinition["actions"] = [];
  for (const action of input) {
    if (!isRecord(action)) continue;
    const id = stringValue(action.id);
    const label = stringValue(action.label);
    const command = stringValue(action.command);
    if (!id || !label || !command) continue;
    actions.push({
      id,
      label,
      command,
      description: nullableString(action.description),
      icon: nullableString(action.icon),
      requiresConfirmation: Boolean(action.requiresConfirmation ?? action.requires_confirmation),
    });
  }
  return actions.length > 0 ? actions : fallback;
}

function normalizeProdProviderStatus(input: unknown): ProdProviderRuntimeStatus | null {
  if (!isRecord(input)) return null;
  const providerId = stringValue(input.providerId ?? input.provider_id ?? input.id);
  if (!providerId) return null;
  const cliStatus = normalizeCliStatus(input.cliStatus ?? input.cli_status);
  const derivedCliStatus = cliStatus !== "unknown"
    ? cliStatus
    : typeof input.installed === "boolean"
      ? input.installed
        ? "installed"
        : "missing"
      : "unknown";
  const authStatus = normalizeAuthStatus(input.authStatus ?? input.auth_status ?? input.authState ?? input.auth_state);
  const derivedAuthStatus = authStatus !== "unknown"
    ? authStatus
    : input.connected === true
      ? "connected"
      : input.connected === false
        ? "disconnected"
        : "unknown";
  return {
    providerId,
    cliStatus: derivedCliStatus,
    authStatus: derivedAuthStatus,
    identity: nullableString(input.identity),
    error: nullableString(input.error) ?? (derivedAuthStatus === "error" || derivedCliStatus === "error" ? nullableString(input.message) : null),
    tokenConfigured: Boolean(input.tokenConfigured ?? input.token_configured),
    tokenPreview: nullableString(input.tokenPreview ?? input.token_preview),
    lastCheckedMs: numberOrNull(input.lastCheckedMs ?? input.last_checked_ms ?? input.checkedAtMs ?? input.checked_at_ms),
  };
}

function normalizeCliStatus(value: unknown): ProdCliStatus {
  return value === "checking" || value === "installed" || value === "missing" || value === "error"
    ? value
    : "unknown";
}

function normalizeAuthStatus(value: unknown): ProdAuthStatus {
  return value === "checking" ||
    value === "connected" ||
    value === "disconnected" ||
    value === "error"
    ? value
    : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text.length > 0 ? text : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
