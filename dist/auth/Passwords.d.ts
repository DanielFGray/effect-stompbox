import { Context, Effect, Layer, Option } from 'effect';
import { OwnerPool } from '../visitor/index.ts';
import { AccountLocked, InvalidCredentials } from './api.ts';
import { Sessions } from './Sessions.ts';
declare const Passwords_base: Context.ServiceClass<Passwords, "@danielfgray/stompbox/auth/Passwords", {
    createUser: (password: string) => Effect.Effect<string, import("../db/DatabaseError.ts").DatabaseError, never>;
    set: (userId: string, password: string) => Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
    signIn: (userId: Option.Option<string>, password: string) => Effect.Effect<{
        sessionId: string;
        token: string;
        expiresAt: Date;
        absoluteExpiresAt: Date;
    }, AccountLocked | import("../db/DatabaseError.ts").DatabaseError | InvalidCredentials, never>;
}> & {
    readonly make: Effect.Effect<{
        createUser: (password: string) => Effect.Effect<string, import("../db/DatabaseError.ts").DatabaseError, never>;
        set: (userId: string, password: string) => Effect.Effect<void, import("../db/DatabaseError.ts").DatabaseError, never>;
        signIn: (userId: Option.Option<string>, password: string) => Effect.Effect<{
            sessionId: string;
            token: string;
            expiresAt: Date;
            absoluteExpiresAt: Date;
        }, AccountLocked | import("../db/DatabaseError.ts").DatabaseError | InvalidCredentials, never>;
    }, never, OwnerPool | Sessions>;
};
/**
 * Password sign-in over the feature `passwords`, on the owner pool. SQL
 * hashes and checks the password and counts failures; this service creates
 * the session. The password is always a bound parameter, never SQL text.
 */
export declare class Passwords extends Passwords_base {
    static readonly layer: Layer.Layer<Passwords, never, OwnerPool | Sessions>;
}
export {};
