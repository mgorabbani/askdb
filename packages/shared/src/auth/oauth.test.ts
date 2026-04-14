import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import {
  createAuthorizationCodeGrant,
  exchangeAuthorizationCodeGrant,
  exchangeRefreshTokenGrant,
  getAuthorizationCodeChallenge,
  getOAuthAuditApiKeyId,
  getOAuthClient,
  normalizeOAuthScopes,
  revokeOAuthToken,
  storeOAuthClient,
  verifyOAuthAccessToken,
  type OAuthClientRecord,
} from "./oauth.js";
import { resetTestDatabase, seedAuthFixture, testDb } from "../support/sqlite-fixture.js";

function makeClient(): OAuthClientRecord {
  return {
    client_id: "claude-client",
    client_secret: "secret",
    client_id_issued_at: 1,
    client_secret_expires_at: 0,
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

test("OAuth grants can be issued, refreshed, and revoked", () => {
  resetTestDatabase();
  const fixture = seedAuthFixture();
  const client = makeClient();
  const resource = "https://askdb.example.com/mcp";
  const now = new Date();

  storeOAuthClient(testDb, client, now);

  const storedClient = getOAuthClient(testDb, client.client_id);
  assert.deepEqual(storedClient, client);

  const code = createAuthorizationCodeGrant(testDb, {
    clientId: client.client_id,
    connectionId: fixture.connectionId,
    redirectUri: client.redirect_uris[0]!,
    codeChallenge: "challenge-123",
    resource,
    scopes: normalizeOAuthScopes(["mcp:tools"]),
    userId: fixture.userId,
    now,
  });

  assert.equal(
    getAuthorizationCodeChallenge(testDb, client.client_id, code),
    "challenge-123"
  );

  const tokenResponse = exchangeAuthorizationCodeGrant(testDb, {
    client,
    code,
    redirectUri: client.redirect_uris[0],
    resource,
    now,
  });

  assert.match(tokenResponse.access_token, /^ask_at_/);
  assert.match(tokenResponse.refresh_token, /^ask_rt_/);
  assert.equal(tokenResponse.scope, "mcp:tools");

  const verified = verifyOAuthAccessToken(testDb, tokenResponse.access_token, now);
  assert.ok(verified);
  assert.equal(verified?.userId, fixture.userId);
  assert.equal(verified?.connectionId, fixture.connectionId);
  assert.equal(verified?.resource, resource);
  assert.deepEqual(verified?.scopes, ["mcp:tools"]);
  assert.equal(
    verified?.apiKeyId,
    getOAuthAuditApiKeyId(fixture.userId, client.client_id)
  );

  const shadowAuditRow = testDb
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.id, verified!.apiKeyId))
    .get();

  assert.ok(shadowAuditRow);
  assert.ok(shadowAuditRow?.revokedAt);

  const refreshed = exchangeRefreshTokenGrant(testDb, {
    client,
    refreshToken: tokenResponse.refresh_token,
    requestedScopes: ["mcp:tools"],
    requestedResource: resource,
    now,
  });

  assert.notEqual(refreshed.access_token, tokenResponse.access_token);
  assert.notEqual(refreshed.refresh_token, tokenResponse.refresh_token);

  revokeOAuthToken(testDb, client.client_id, refreshed.access_token, now);
  assert.equal(verifyOAuthAccessToken(testDb, refreshed.access_token, now), null);
});
