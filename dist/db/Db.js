import { Effect, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, } from 'kysely';
import { toDatabaseError } from './ToDatabaseError.js';
/**
 * Queries typed by `Tables`, run on the ambient `SqlClient`. Each method takes
 * the Schema of one row, so a query and its Schema that disagree do not
 * compile.
 */
export const db = () => runnerOn(Effect.service(SqlClient));
/**
 * The same runner on the connection `client` names. A package that binds a
 * connection, such as the visitor's transaction, builds its runner with this.
 */
export const runnerOn = (client) => {
    const kysely = compiler();
    const run = (build) => Effect.gen(function* () {
        const sql = yield* client;
        const query = build(kysely).compile();
        return yield* sql.unsafe(query.sql, query.parameters).pipe(toDatabaseError);
    });
    const rows = (schema, build) => Effect.flatMap(run(build), (raw) => Schema.decodeUnknownEffect(Schema.Array(schema))(raw).pipe(Effect.orDie));
    return {
        /** Runs a statement whose rows the caller does not read, such as an update with no `returning`. */
        exec: (build) => Effect.asVoid(run(build)),
        /** Every row. */
        all: rows,
        /** The first row, or none. */
        maybe: (schema, build) => Effect.map(rows(schema, build), (all) => Option.fromNullishOr(all[0])),
        /** The one row the query must return, such as an insert's `returning`; none is a defect. */
        one: (schema, build) => Effect.flatMap(rows(schema, build), (all) => Option.match(Option.fromNullishOr(all[0]), {
            onNone: () => Effect.die(new QueryReturnedNoRow()),
            onSome: Effect.succeed,
        })),
    };
};
/** A defect: a query that must return a row returned none. */
export class QueryReturnedNoRow extends Schema.TaggedError()('QueryReturnedNoRow', {}) {
}
/** A Kysely that compiles Postgres SQL and has no connection of its own. */
const compiler = () => new Kysely({
    dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
    },
});
