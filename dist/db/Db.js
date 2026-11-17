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
    const rows = (schema, build) => Effect.gen(function* () {
        const sql = yield* client;
        const query = build(kysely).compile();
        const raw = yield* sql.unsafe(query.sql, query.parameters).pipe(toDatabaseError);
        return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(raw).pipe(Effect.orDie);
    });
    return {
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
