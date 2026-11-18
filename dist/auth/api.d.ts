import { Context, Schema } from 'effect';
import * as HttpApiError from 'effect/http-api/HttpApiError';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as HttpApiSecurity from 'effect/http-api/HttpApiSecurity';
import { DatabaseError } from '../db/DatabaseError.ts';
import type { VisitorTransaction } from '../visitor/index.ts';
/** A live session and the user it belongs to. */
export interface LiveSession {
    readonly sessionId: string;
    readonly userId: string;
}
declare const CurrentSession_base: Context.ServiceClass<CurrentSession, "@danielfgray/stompbox/auth/CurrentSession", LiveSession>;
/** The signed-in request's session. `SignedIn` provides it. */
export declare class CurrentSession extends CurrentSession_base {
}
declare const SignedIn_base: HttpApiMiddleware.ServiceClass<SignedIn, "@danielfgray/stompbox/auth/SignedIn", {
    requires: never;
    provides: CurrentSession | VisitorTransaction;
    error: readonly [typeof HttpApiError.Unauthorized, typeof DatabaseError];
    clientError: never;
    requiredForClient: false;
    security: {
        readonly session: HttpApiSecurity.ApiKey;
    };
}, HttpApiMiddleware.HttpApiMiddlewareSecurity<{
    readonly session: HttpApiSecurity.ApiKey;
}, CurrentSession | VisitorTransaction, readonly [typeof HttpApiError.Unauthorized, typeof DatabaseError], never>>;
/**
 * Guards an API group or endpoint: the request must carry a live session in
 * the cookie `__Host-session`, or it gets 401 and the handler does not run.
 * The server's implementation (`SignedInLive` in `@danielfgray/stompbox/auth/http`)
 * runs the endpoint in one visitor transaction as the signed-in user, and
 * provides `CurrentSession` and `VisitorTransaction` to it. It declares
 * `DatabaseError` (a failure at begin or commit), so an app that uses it needs
 * the failure boundary from `@danielfgray/stompbox/http/server` to answer it.
 */
export declare class SignedIn extends SignedIn_base {
}
declare const InvalidCredentials_base: Schema.Class<InvalidCredentials, Schema.TaggedStruct<"InvalidCredentials", {}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The user is unknown, has no password, or gave the wrong one. */
export declare class InvalidCredentials extends InvalidCredentials_base {
}
declare const AccountLocked_base: Schema.Class<AccountLocked, Schema.TaggedStruct<"AccountLocked", {}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** Too many failed sign-ins in a short time; the user must wait. */
export declare class AccountLocked extends AccountLocked_base {
}
export {};
