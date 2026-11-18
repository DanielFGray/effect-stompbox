import { Effect, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import { type Compilable, Kysely } from 'kysely';
/**
 * Queries typed by `Tables`, run on the ambient `SqlClient`. Each method takes
 * the Schema of one row, so a query and its Schema that disagree do not
 * compile.
 */
export declare const db: <Tables>() => {
    /** Runs a statement whose rows the caller does not read, such as an update with no `returning`. */
    exec: (build: (db: Kysely<Tables>) => Compilable<unknown>) => Effect.Effect<void, import("./DatabaseError.ts").DatabaseError, SqlClient>;
    /** Every row. */
    all: <A, I, O>(schema: Schema.Codec<A, I, never, never>, build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>) => Effect.Effect<readonly A[], import("./DatabaseError.ts").DatabaseError, SqlClient>;
    /** The first row, or none. */
    maybe: <A, I, O>(schema: Schema.Codec<A, I, never, never>, build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>) => Effect.Effect<Option.Option<A & {}>, import("./DatabaseError.ts").DatabaseError, SqlClient>;
    /** The one row the query must return, such as an insert's `returning`; none is a defect. */
    one: <A, I, O>(schema: Schema.Codec<A, I, never, never>, build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>) => Effect.Effect<A & {}, import("./DatabaseError.ts").DatabaseError, SqlClient>;
};
/**
 * The same runner on the connection `client` names. A package that binds a
 * connection, such as the visitor's transaction, builds its runner with this.
 */
export declare const runnerOn: <Tables, R>(client: Effect.Effect<SqlClient, never, R>) => {
    /** Runs a statement whose rows the caller does not read, such as an update with no `returning`. */
    exec: (build: (db: Kysely<Tables>) => Compilable<unknown>) => Effect.Effect<void, import("./DatabaseError.ts").DatabaseError, R>;
    /** Every row. */
    all: <A, I, O>(schema: Schema.Codec<A, I>, build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>) => Effect.Effect<readonly A[], import("./DatabaseError.ts").DatabaseError, R>;
    /** The first row, or none. */
    maybe: <A, I, O>(schema: Schema.Codec<A, I>, build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>) => Effect.Effect<Option.Option<A & {}>, import("./DatabaseError.ts").DatabaseError, R>;
    /** The one row the query must return, such as an insert's `returning`; none is a defect. */
    one: <A, I, O>(schema: Schema.Codec<A, I>, build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>) => Effect.Effect<A & {}, import("./DatabaseError.ts").DatabaseError, R>;
};
/**
 * No constraint when every row the query returns is an input the Schema
 * accepts. Otherwise a property no query has, whose type names the mismatch,
 * so the call does not compile. A constraint on the row type would not do this:
 * Kysely's `Compilable` does not use its type parameter, so TypeScript would
 * fall back to the constraint and accept any query.
 */
type Fits<Row, Input> = [Row] extends [Input] ? unknown : {
    readonly rowDoesNotFitSchema: {
        readonly row: Row;
        readonly schemaInput: Input;
    };
};
declare const QueryReturnedNoRow_base: Schema.Class<QueryReturnedNoRow, Schema.TaggedStruct<"QueryReturnedNoRow", {}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A defect: a query that must return a row returned none. */
export declare class QueryReturnedNoRow extends QueryReturnedNoRow_base {
}
export {};
