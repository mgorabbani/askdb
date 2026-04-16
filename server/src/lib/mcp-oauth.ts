import type { Request, RequestHandler } from "express";
import {
  mcpAuthRouter,
  type AuthRouterOptions,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  db,
  MCP_OAUTH_SUPPORTED_SCOPES,
  createAuthorizationCodeGrant,
  exchangeAuthorizationCodeGrant,
  exchangeRefreshTokenGrant,
  getAuthorizationCodeChallenge,
  getDefaultConnectionForUser,
  getOAuthClient,
  normalizeOAuthScopes,
  revokeOAuthToken,
  storeOAuthClient,
  verifyOAuthAccessToken,
  getOAuthIssuerUrl,
  getMcpPublicUrl,
  type OAuthClientRecord,
} from "@askdb/shared";
import { getSession } from "./session.js";

export { getOAuthIssuerUrl, getMcpPublicUrl };

export function createMcpOAuthRouter(): RequestHandler {
  const issuerUrl = getOAuthIssuerUrl();
  const resourceServerUrl = getMcpPublicUrl();

  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(clientId) {
        const client = getOAuthClient(db, clientId);
        console.log(`[mcp-oauth] getClient(${clientId}) -> ${client ? "hit" : "miss"}`);
        return client;
      },
      async registerClient(client) {
        const record = normalizeClientRecord(client as OAuthClientRecord);
        console.log(`[mcp-oauth] registerClient id=${record.client_id} name=${record.client_name ?? "-"}`);
        return storeOAuthClient(db, record);
      },
    },

    async authorize(client, params, res) {
      console.log(`[mcp-oauth] authorize method=${(res.req as Request).method} client=${client.client_id} scopes=${JSON.stringify(params.scopes)} resource=${params.resource?.toString() ?? "-"}`);
      const req = res.req as Request;
      const session = await getSession(req);

      if (!session) {
        const next = encodeURIComponent(req.originalUrl || req.url || "/authorize");
        res.redirect(`/login?next=${next}`);
        return;
      }

      const connection = getDefaultConnectionForUser(db, session.user.id);
      if (!connection) {
        res.status(400).type("html").send(renderMissingConnectionPage());
        return;
      }

      const requestedResource = params.resource?.toString() ?? resourceServerUrl.href;
      if (!checkResourceAllowed({
        requestedResource,
        configuredResource: resourceServerUrl,
      })) {
        throw new InvalidTargetError(`Requested resource is not allowed: ${requestedResource}`);
      }

      let scopes: string[];
      try {
        scopes = normalizeOAuthScopes(params.scopes);
      } catch (error) {
        throw new InvalidScopeError(
          error instanceof Error ? error.message : "Unsupported scope requested"
        );
      }

      if (req.method === "GET") {
        res.status(200).type("html").send(
          renderConsentPage({
            client,
            connectionName: connection.name,
            params: {
              ...params,
              resource: requestedResource,
              scopes,
            },
            formAction: req.originalUrl.split("?")[0] || "/authorize",
          })
        );
        return;
      }

      const action = readFormValue(req, "action");
      if (action !== "approve") {
        throw new AccessDeniedError("User denied the authorization request");
      }

      const code = createAuthorizationCodeGrant(db, {
        clientId: client.client_id,
        connectionId: connection.id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        resource: requestedResource,
        scopes,
        userId: session.user.id,
      });

      const redirectUrl = new URL(params.redirectUri);
      redirectUrl.searchParams.set("code", code);
      if (params.state) {
        redirectUrl.searchParams.set("state", params.state);
      }

      res.redirect(redirectUrl.toString());
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      try {
        const challenge = getAuthorizationCodeChallenge(db, client.client_id, authorizationCode);
        console.log(`[mcp-oauth] challengeForAuthorizationCode client=${client.client_id} ok`);
        return challenge;
      } catch (error) {
        console.error(`[mcp-oauth] challengeForAuthorizationCode FAILED client=${client.client_id}:`, error);
        throw error;
      }
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      try {
        const result = exchangeAuthorizationCodeGrant(db, {
          client: normalizeClientRecord(client),
          code: authorizationCode,
          redirectUri,
          resource: resource?.toString(),
        });
        console.log(`[mcp-oauth] exchangeAuthorizationCode client=${client.client_id} redirectUri=${redirectUri ?? "-"} resource=${resource?.toString() ?? "-"} ok`);
        return result;
      } catch (error) {
        console.error(`[mcp-oauth] exchangeAuthorizationCode FAILED client=${client.client_id} redirectUri=${redirectUri ?? "-"} resource=${resource?.toString() ?? "-"}:`, error);
        throw new InvalidGrantError(
          error instanceof Error ? error.message : "Invalid authorization code"
        );
      }
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      try {
        const result = exchangeRefreshTokenGrant(db, {
          client: normalizeClientRecord(client),
          refreshToken,
          requestedResource: resource?.toString(),
          requestedScopes: scopes,
        });
        console.log(`[mcp-oauth] exchangeRefreshToken client=${client.client_id} ok`);
        return result;
      } catch (error) {
        console.error(`[mcp-oauth] exchangeRefreshToken FAILED client=${client.client_id}:`, error);
        const message = error instanceof Error ? error.message : "Invalid refresh token";
        if (message.includes("scope")) {
          throw new InvalidScopeError(message);
        }
        if (message.includes("resource")) {
          throw new InvalidTargetError(message);
        }
        throw new InvalidGrantError(message);
      }
    },

    async verifyAccessToken(token) {
      const verified = verifyOAuthAccessToken(db, token);
      if (!verified) {
        console.warn(`[mcp-oauth] verifyAccessToken miss tokenPrefix=${token.slice(0, 10)}`);
        throw new Error("Invalid or expired token");
      }
      console.log(`[mcp-oauth] verifyAccessToken ok client=${verified.clientId} user=${verified.userId}`);

      return {
        token,
        clientId: verified.clientId,
        scopes: verified.scopes,
        expiresAt: Math.floor(verified.expiresAt.getTime() / 1000),
        resource: new URL(verified.resource),
        extra: {
          apiKeyId: verified.apiKeyId,
          authType: "oauth",
          connectionId: verified.connectionId,
          userId: verified.userId,
        },
      };
    },

    async revokeToken(client, request) {
      revokeOAuthToken(db, client.client_id, request.token);
    },
  };

  const options: AuthRouterOptions = {
    provider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: [...MCP_OAUTH_SUPPORTED_SCOPES],
    resourceName: "askdb MCP",
    serviceDocumentationUrl: new URL("/dashboard/setup", issuerUrl),
  };

  return mcpAuthRouter(options);
}

function normalizeClientRecord(client: OAuthClientRecord): OAuthClientRecord {
  return {
    ...client,
    redirect_uris: [...client.redirect_uris],
  };
}

function readFormValue(req: Request, key: string): string | null {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : null;
}

function renderMissingConnectionPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>askdb OAuth</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; }
      main { max-width: 40rem; margin: 8vh auto; padding: 2rem; background: white; border-radius: 1rem; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
      a { color: #0f766e; text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <h1>No synced connection available</h1>
      <p>askdb needs at least one synced database connection before Claude can connect over MCP.</p>
      <p><a href="/dashboard/connect">Open the dashboard and add a connection</a></p>
    </main>
  </body>
</html>`;
}

function renderConsentPage(input: {
  client: OAuthClientRecord;
  connectionName: string;
  params: {
    codeChallenge: string;
    redirectUri: string;
    resource: string;
    scopes: string[];
    state?: string;
  };
  formAction: string;
}) {
  const clientName = escapeHtml(input.client.client_name || input.client.client_id);
  const redirectUri = escapeHtml(input.params.redirectUri);
  const resource = escapeHtml(input.params.resource);
  const scopeList = input.params.scopes
    .map((scope) => `<li>${escapeHtml(scope)}</li>`)
    .join("");

  const hidden = [
    hiddenField("client_id", input.client.client_id),
    hiddenField("redirect_uri", input.params.redirectUri),
    hiddenField("response_type", "code"),
    hiddenField("code_challenge", input.params.codeChallenge),
    hiddenField("code_challenge_method", "S256"),
    hiddenField("resource", input.params.resource),
    hiddenField("scope", input.params.scopes.join(" ")),
    input.params.state ? hiddenField("state", input.params.state) : "",
  ].join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize askdb MCP</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background:
        radial-gradient(circle at top left, #ccfbf1, transparent 30%),
        linear-gradient(135deg, #f5f5f4, #e7e5e4); color: #1c1917; }
      main { max-width: 44rem; margin: 8vh auto; background: rgba(255,255,255,0.92); border-radius: 1.25rem; box-shadow: 0 16px 60px rgba(0,0,0,.12); overflow: hidden; }
      header { padding: 2rem 2rem 1rem; border-bottom: 1px solid #e7e5e4; }
      section { padding: 1.5rem 2rem 2rem; }
      h1 { margin: 0 0 .5rem; font-size: 1.75rem; }
      p { margin: .25rem 0; line-height: 1.5; color: #44403c; }
      dl { display: grid; grid-template-columns: 10rem 1fr; gap: .75rem 1rem; margin: 1.5rem 0; }
      dt { font-size: .9rem; color: #78716c; }
      dd { margin: 0; word-break: break-word; }
      ul { margin: .5rem 0 0 1.25rem; color: #292524; }
      form { display: flex; gap: .75rem; margin-top: 1.5rem; }
      button { border: 0; border-radius: .8rem; padding: .85rem 1.1rem; font: inherit; cursor: pointer; }
      .approve { background: #0f766e; color: white; font-weight: 600; }
      .deny { background: #e7e5e4; color: #292524; }
      .pill { display: inline-block; padding: .3rem .55rem; border-radius: 999px; background: #ccfbf1; color: #115e59; font-size: .8rem; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="pill">askdb MCP</span>
        <h1>Authorize ${clientName}</h1>
        <p>This client is requesting access to your askdb MCP server.</p>
      </header>
      <section>
        <dl>
          <dt>Client</dt>
          <dd>${clientName}</dd>
          <dt>Connection</dt>
          <dd>${escapeHtml(input.connectionName)}</dd>
          <dt>Redirect URI</dt>
          <dd><code>${redirectUri}</code></dd>
          <dt>Resource</dt>
          <dd><code>${resource}</code></dd>
          <dt>Scopes</dt>
          <dd><ul>${scopeList}</ul></dd>
        </dl>
        <form method="post" action="${escapeHtml(input.formAction)}">
          ${hidden}
          <button class="approve" type="submit" name="action" value="approve">Approve</button>
          <button class="deny" type="submit" name="action" value="deny">Deny</button>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function hiddenField(name: string, value: string) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
