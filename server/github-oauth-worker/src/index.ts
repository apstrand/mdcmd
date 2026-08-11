// Minimal GitHub OAuth token-exchange proxy.
//
// The static web app (src/storage/github/auth.ts) redirects the user to GitHub,
// gets back a temporary `code`, and POSTs it here. This Worker holds the OAuth
// App's client secret and swaps the code for an access token, which the browser
// then uses to call the GitHub API directly. The secret never reaches the
// browser.
//
// Configure:
//   Secrets:  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET  (wrangler secret put ...)
//   Var:      ALLOWED_ORIGIN  = https://your-site.example  (the app's origin)

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    // A plain GET (e.g. opening the URL in a browser) is a liveness check, not
    // the token exchange — answer it so it isn't mistaken for a failure.
    if (request.method === "GET") {
      return new Response(
        "mdcmd GitHub OAuth proxy is running. POST { code, redirect_uri } to exchange a token.\n",
        { status: 200, headers: { "Content-Type": "text/plain", ...corsHeaders(origin) } },
      );
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    let body: { code?: string; redirect_uri?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400, origin);
    }
    if (!body.code) {
      return json({ error: "missing_code" }, 400, origin);
    }

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: body.code,
        redirect_uri: body.redirect_uri,
      }),
    });

    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      return json({ error: data.error ?? "exchange_failed" }, 400, origin);
    }
    // Return only the access token; never leak the full GitHub response.
    return json({ access_token: data.access_token }, 200, origin);
  },
};

function json(payload: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
