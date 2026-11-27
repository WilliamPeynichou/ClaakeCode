// Parameters the app is opened with after a redirect (GitHub or OpenRouter sign-in); they are removed from the URL.
const params = new URLSearchParams(location.search);

export const launchParams = {
  tab: params.get("tab"),
  authError: params.get("auth_error"),
  openrouterCode: params.get("openrouter") === "callback" ? params.get("code") : null,
};

if (launchParams.tab || launchParams.authError || params.get("openrouter")) history.replaceState(null, "", "/");
