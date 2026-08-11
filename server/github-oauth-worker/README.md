# GitHub OAuth proxy

A tiny serverless endpoint that performs the GitHub OAuth **code → access token**
exchange for the static web build. It exists because the exchange requires the
OAuth App's *client secret*, which must never be shipped in frontend code.

The frontend (`src/storage/github/auth.ts`) POSTs `{ code, redirect_uri }` here
and receives `{ access_token }`.

This reference implementation is a Cloudflare Worker, but the contract is trivial
— you can reimplement it on any platform (a PHP script, a small Node route on the
same server that hosts the site, etc.). The frontend only cares about the URL,
set via `VITE_GITHUB_OAUTH_PROXY`.

## Setup (Cloudflare Workers)

1. Create a GitHub **OAuth App** at <https://github.com/settings/developers>:
   - **Homepage URL** / **Authorization callback URL**: your site's URL
     (e.g. `https://mdcmd.example.com/`). Use `http://localhost:1420/` too for
     local testing.
   - Note the **Client ID** and generate a **Client secret**.

2. Deploy the worker:

   ```sh
   cd server/github-oauth-worker
   npm install
   npx wrangler secret put GITHUB_CLIENT_ID       # paste the client id
   npx wrangler secret put GITHUB_CLIENT_SECRET    # paste the client secret
   # Edit ALLOWED_ORIGIN in wrangler.jsonc to your deployed site origin.
   npm run deploy
   ```

3. Point the frontend at the worker by setting, at build time:

   ```sh
   VITE_GITHUB_CLIENT_ID=<the OAuth App client id>
   VITE_GITHUB_OAUTH_PROXY=https://mdcmd-github-oauth.<your-subdomain>.workers.dev
   ```

## Contract

`POST` with JSON body `{ "code": "...", "redirect_uri": "..." }`:

- **200** `{ "access_token": "gho_..." }` on success
- **400** `{ "error": "..." }` otherwise

CORS is restricted to `ALLOWED_ORIGIN`.
