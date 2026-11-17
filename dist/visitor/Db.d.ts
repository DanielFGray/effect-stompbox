import { Effect } from 'effect';
import { OwnerPool } from './Pools.ts';
import { VisitorTransaction } from './Visitor.ts';
/**
 * Queries as the visitor, typed by `Tables`. Each method needs
 * `VisitorTransaction`, which only `Visitor.run` provides, so a visitor query
 * outside a request does not compile.
 */
export declare const visitorDb: <Tables>() => {
    all: <A, I, O>(schema: import("effect/Schema").Codec<A, I, never, never>, build: (db: import("kysely").Kysely<Tables>) => import("kysely").Compilable<O> & ([O] extends [I] ? unknown : {
        readonly rowDoesNotFitSchema: {
            readonly row: O;
            readonly schemaInput: I;
        };
    })) => Effect.Effect<readonly A[], import("../db/DatabaseError.ts").DatabaseError, VisitorTransaction>;
    maybe: <A, I, O>(schema: import("effect/Schema").Codec<A, I, never, never>, build: (db: import("kysely").Kysely<Tables>) => import("kysely").Compilable<O> & ([O] extends [I] ? unknown : {
        readonly rowDoesNotFitSchema: {
            readonly row: O;
            readonly schemaInput: I;
        };
    })) => Effect.Effect<import("effect/Option").Option<A & {}>, import("../db/DatabaseError.ts").DatabaseError, VisitorTransaction>;
    one: <A, I, O>(schema: import("effect/Schema").Codec<A, I, never, never>, build: (db: import("kysely").Kysely<Tables>) => import("kysely").Compilable<O> & ([O] extends [I] ? unknown : {
        readonly rowDoesNotFitSchema: {
            readonly row: O;
            readonly schemaInput: I;
        };
    })) => Effect.Effect<A & {}, import("../db/DatabaseError.ts").DatabaseError, VisitorTransaction>;
};
/**
 * Queries as the owner, typed by `Tables`. Row-level security does not limit
 * the owner, so only code that asks for `OwnerPool` by name can run these.
 * `withTransaction` runs an effect in one owner transaction; every owner query
 * inside it, from this runner or from another service on `OwnerPool`, joins it.
 * A failure at begin or commit (a deferred constraint) is a `DatabaseError`.
 */
export declare const ownerDb: <Tables>() => {
    all: <A, I, O>(schema: import("effect/Schema").Codec<A, I, never, never>, build: (db: import("kysely").Kysely<Tables>) => import("kysely").Compilable<O> & ([O] extends [I] ? unknown : {
        readonly rowDoesNotFitSchema: {
            readonly row: O;
            readonly schemaInput: I;
        };
    })) => Effect.Effect<readonly A[], import("../db/DatabaseError.ts").DatabaseError, OwnerPool>;
    maybe: <A, I, O>(schema: import("effect/Schema").Codec<A, I, never, never>, build: (db: import("kysely").Kysely<Tables>) => import("kysely").Compilable<O> & ([O] extends [I] ? unknown : {
        readonly rowDoesNotFitSchema: {
            readonly row: O;
            readonly schemaInput: I;
        };
    })) => Effect.Effect<import("effect/Option").Option<A & {}>, import("../db/DatabaseError.ts").DatabaseError, OwnerPool>;
    one: <A, I, O>(schema: import("effect/Schema").Codec<A, I, never, never>, build: (db: import("kysely").Kysely<Tables>) => import("kysely").Compilable<O> & ([O] extends [I] ? unknown : {
        readonly rowDoesNotFitSchema: {
            readonly row: O;
            readonly schemaInput: I;
        };
    })) => Effect.Effect<A & {}, import("../db/DatabaseError.ts").DatabaseError, OwnerPool>;
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, import("../db/DatabaseError.ts").DatabaseError | Exclude<E, import("effect/sql/SqlError").SqlError>, R | OwnerPool>;
};
