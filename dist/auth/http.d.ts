import { Effect, Layer } from 'effect';
import { Visitor } from '../visitor/index.ts';
import { SignedIn } from './api.ts';
import { type CreatedSession, Sessions } from './Sessions.ts';
/**
 * Implements `SignedIn`: validates the session cookie, then runs the
 * endpoint (payload decoding, handler and response encoding) in one
 * `Visitor.run` as the session's user. A typed error from the handler rolls
 * the transaction back and reaches the client with its own status.
 */
export declare const SignedInLive: Layer.Layer<SignedIn, never, Sessions | Visitor>;
/**
 * Sets and clears the session cookie from a handler. The name and the
 * attributes come from `SignedIn`'s security scheme, so the cookie the
 * server sets is the one `SignedIn` reads.
 */
export declare const SessionCookie: {
    /**
     * Sets the cookie to a new session's token. It expires with the session's
     * absolute expiry, which `validate` never moves, so no later request
     * needs to set it again.
     */
    set: (session: CreatedSession) => Effect.Effect<void, never, import("effect/http/HttpServerRequest").HttpServerRequest>;
    /** Tells the browser to delete the cookie. Same name, path and flags, or the browser keeps it. */
    clear: Effect.Effect<void, never, import("effect/http/HttpServerRequest").HttpServerRequest>;
};
