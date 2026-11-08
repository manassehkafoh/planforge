import { createHmac, timingSafeEqual } from 'node:crypto';
import { Problem } from './errors.ts';

/**
 * HS256 JWT verification for the reference server (development / test IdP).
 * Production verifies RS256/ES256 access tokens against the OIDC provider's JWKS; the claims contract is identical:
 *   iss, aud, exp, nbf?, sub (OIDC subject), tid (tenant uuid).
 */
export interface Claims { sub: string; tid: string; iss: string; aud: string; exp: number; nbf?: number }
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISSUER = 'planforge-dev-idp', AUDIENCE = 'planforge-api', SKEW_S = 60;

export function sign(claims: Omit<Claims, 'iss' | 'aud'> & Partial<Pick<Claims, 'iss' | 'aud'>>, secret: string): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, ...claims }));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

export function verify(token: string | undefined, secret: string, now = Date.now()): Claims {
  const fail = () => new Problem('UNAUTHENTICATED', 'Missing, malformed or expired credentials');
  if (!token || token.length > 4096) throw fail();
  const parts = token.split('.');
  if (parts.length !== 3) throw fail();
  let header: { alg?: string; typ?: string }, claims: Partial<Claims>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw fail(); }
  if (header.alg !== 'HS256') throw fail();              // rejects alg=none and algorithm confusion
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail();
  const t = Math.floor(now / 1000);
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) throw fail();
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) throw fail();
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - SKEW_S > t)) throw fail();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 200) throw fail();
  if (typeof claims.tid !== 'string' || !UUID.test(claims.tid)) throw fail();
  return claims as Claims;
}
