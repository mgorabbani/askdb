// Base CSP directives. Shared between the global helmet middleware and the
// OAuth consent page, which needs to extend form-action with the validated
// client redirect_uri origin — browsers enforce form-action across the whole
// redirect chain, so a 'self'-only policy blocks legitimate OAuth callback
// redirects to third-party clients (e.g. https://claude.ai/api/mcp/auth_callback).

export type CspDirectives = Record<string, string[]>;

export const CSP_DIRECTIVES: CspDirectives = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
};

export function serializeCspDirectives(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

// Clones CSP_DIRECTIVES and appends the given origins to form-action.
// Origins must already be validated against registered redirect_uris by the
// caller — untrusted input here would let a malicious client broaden CSP.
export function cspWithFormActionOrigins(origins: string[]): string {
  const directives: CspDirectives = Object.fromEntries(
    Object.entries(CSP_DIRECTIVES).map(([k, v]) => [k, [...v]])
  );
  directives["form-action"] = [...(directives["form-action"] ?? []), ...origins];
  return serializeCspDirectives(directives);
}
