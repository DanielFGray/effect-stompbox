import { Effect, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'
import {
	type Compilable,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from 'kysely'

import { toDatabaseError } from './ToDatabaseError.ts'

/**
 * Queries typed by `Tables`, run on the ambient `SqlClient`. Each method takes
 * the Schema of one row, so a query and its Schema that disagree do not
 * compile.
 */
export const db = <Tables>() => runnerOn<Tables, SqlClient>(Effect.service(SqlClient))

/**
 * The same runner on the connection `client` names. A package that binds a
 * connection, such as the visitor's transaction, builds its runner with this.
 */
export const runnerOn = <Tables, R>(client: Effect.Effect<SqlClient, never, R>) => {
	const kysely = compiler<Tables>()
	const run = (build: (db: Kysely<Tables>) => Compilable<unknown>) =>
		Effect.gen(function* () {
			const sql = yield* client
			const query = build(kysely).compile()
			return yield* sql.unsafe(query.sql, query.parameters).pipe(toDatabaseError)
		})
	const rows = <A, I, O>(
		schema: Schema.Codec<A, I>,
		build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>,
	) =>
		Effect.flatMap(run(build), (raw) =>
			Schema.decodeUnknownEffect(Schema.Array(schema))(raw).pipe(Effect.orDie),
		)

	return {
		/** Runs a statement whose rows the caller does not read, such as an update with no `returning`. */
		exec: (build: (db: Kysely<Tables>) => Compilable<unknown>) =>
			Effect.asVoid(run(build)),
		/** Every row. */
		all: rows,
		/** The first row, or none. */
		maybe: <A, I, O>(
			schema: Schema.Codec<A, I>,
			build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>,
		) => Effect.map(rows(schema, build), (all) => Option.fromNullishOr(all[0])),
		/** The one row the query must return, such as an insert's `returning`; none is a defect. */
		one: <A, I, O>(
			schema: Schema.Codec<A, I>,
			build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>,
		) =>
			Effect.flatMap(rows(schema, build), (all) =>
				Option.match(Option.fromNullishOr(all[0]), {
					onNone: () => Effect.die(new QueryReturnedNoRow()),
					onSome: Effect.succeed,
				}),
			),
	}
}

/**
 * No constraint when every row the query returns is an input the Schema
 * accepts. Otherwise a property no query has, whose type names the mismatch,
 * so the call does not compile. A constraint on the row type would not do this:
 * Kysely's `Compilable` does not use its type parameter, so TypeScript would
 * fall back to the constraint and accept any query.
 */
type Fits<Row, Input> = [Row] extends [Input]
	? unknown
	: { readonly rowDoesNotFitSchema: { readonly row: Row; readonly schemaInput: Input } }

/** A defect: a query that must return a row returned none. */
export class QueryReturnedNoRow extends Schema.TaggedError<
	QueryReturnedNoRow,
	{ readonly brand: unique symbol }
>()('QueryReturnedNoRow', {}) {}

/** A Kysely that compiles Postgres SQL and has no connection of its own. */
const compiler = <Tables>() =>
	new Kysely<Tables>({
		dialect: {
			createAdapter: () => new PostgresAdapter(),
			createDriver: () => new DummyDriver(),
			createIntrospector: (db) => new PostgresIntrospector(db),
			createQueryCompiler: () => new PostgresQueryCompiler(),
		},
	})
