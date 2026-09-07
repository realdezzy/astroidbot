/**
 * The claims every access token is signed with and verified against.
 *
 * Kept in one module because a signer and a verifier that disagree about
 * `issuer` reject every token, and one that disagrees about `algorithms`
 * accepts more than it should. Neither failure is visible from reading either
 * side alone.
 */

/**
 * The only algorithm this service issues or accepts.
 *
 * `jwt.verify` with no `algorithms` accepts anything the key type supports.
 * jsonwebtoken v9 blocks the classic HMAC-vs-RSA confusion on its own, so
 * pinning is defence in depth rather than a live hole — but it costs nothing
 * and removes a class of bug from consideration entirely.
 */
export const JWT_ALGORITHM = "HS256" as const;

/** Names this service in its own tokens, so another service's cannot be replayed here. */
export const JWT_ISSUER = "astroidbot";
