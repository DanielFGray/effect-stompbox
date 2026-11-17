import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import * as Digest from 'effect/crypto/Digest';
import * as SecureRandom from 'effect/crypto/SecureRandom';
import { OwnerPool } from '../visitor/index.ts';
import type { LiveSession } from './api.ts';
/**
 * A new session: the token for the browser, when the session ends unless used
 * (`expiresAt`), and when it ends even if used (`absoluteExpiresAt`).
 */
export interface CreatedSession {
    readonly sessionId: string;
    readonly token: string;
    readonly expiresAt: Date;
    readonly absoluteExpiresAt: Date;
}
declare const Sessions_base: Context.ServiceClass<Sessions, "@danielfgray/stompbox/auth/Sessions", {
    create: (userId: string) => Effect.Effect<{
        sessionId: string;
        token: string;
        expiresAt: Date;
        absoluteExpiresAt: Date;
    }, import("../db/DatabaseError.ts").DatabaseError, never>;
    validate: (token: string) => Effect.Effect<Option.Option<LiveSession>, import("../db/DatabaseError.ts").DatabaseError, never>;
    revoke: (sessionId: string) => Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
    revokeAll: (userId: string) => Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
    deleteExpired: Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
}> & {
    readonly make: Effect.Effect<{
        create: (userId: string) => Effect.Effect<{
            sessionId: string;
            token: string;
            expiresAt: Date;
            absoluteExpiresAt: Date;
        }, import("../db/DatabaseError.ts").DatabaseError, never>;
        validate: (token: string) => Effect.Effect<Option.Option<LiveSession>, import("../db/DatabaseError.ts").DatabaseError, never>;
        revoke: (sessionId: string) => Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
        revokeAll: (userId: string) => Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
        deleteExpired: Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
    }, Config.ConfigError | SessionLifetimesInvalid, Digest.Digest | OwnerPool | SecureRandom.SecureRandom>;
};
/**
 * Creates, validates and revokes sessions on the owner pool. The browser holds
 * the token `<session id>.<secret>`; the database holds only the SHA-256 hash
 * of the secret. `validate` is the one way from a token to a session id, and
 * the visitor transaction sets `my.session_id` only from its result.
 */
export declare class Sessions extends Sessions_base {
    static readonly layer: Layer.Layer<Sessions, Config.ConfigError | SessionLifetimesInvalid, Digest.Digest | OwnerPool | SecureRandom.SecureRandom>;
}
declare const SessionLifetimesInvalid_base: Schema.Class<SessionLifetimesInvalid, Schema.TaggedStruct<"SessionLifetimesInvalid", {
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The session lifetimes in `Config` cannot work together. */
export declare class SessionLifetimesInvalid extends SessionLifetimesInvalid_base {
}
export {};
