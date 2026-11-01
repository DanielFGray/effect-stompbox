import { Effect, Option, Schema } from 'effect'
import type { SqlClient } from 'effect/sql/SqlClient'
import {
	type Compilable,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from 'kysely'

import { OwnerPool } from './Pools.ts'
import { VisitorTransaction } from './Visitor.ts'

/**
 * Queries as the visitor, typed by `Tables`. Each method needs
 * `VisitorTransaction`, which only `Visitor.run` provides, so a visitor query
 * outside a request does not compile.
 */
export const visitorDb = <Tables>() =>
	runner<Tables, VisitorTransaction>(
		Effect.map(Effect.service(VisitorTransaction), (t) => t.sql),
	)

/**
 * Queries as the owner, typed by `Tables`. Row-level security does not limit
 * the owner, so only code that asks for `OwnerPool` by name can run these.
 * `withTransaction` runs an effect in one owner transaction; every owner query
 * inside it, from this runner or from another service on `OwnerPool`, joins it.
 */
export const ownerDb = <Tables>() => {
	const db = runner<Tables, OwnerPool>(Effect.service(OwnerPool))
	return {
		...db,
		withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.flatMap(Effect.service(OwnerPool), (sql) => sql.withTransaction(effect)),
	}
}

/**
 * Builds queries with Kysely and runs them through `SqlClient`. Kysely only
 * compiles (ADR 0006). Each method takes the Schema of one row: its encoded
 * type must accept the row type Kysely infers, so a query and its Schema that
 * disagree do not compile, and the driver's values are decoded at run time. A
 * row the Schema rejects is a defect: the database and the code disagree.
 */
const runner = <Tables, R>(client: Effect.Effect<SqlClient, never, R>) => {
	const kysely = compiler<Tables>()
	const rows = <A, I, O>(
		schema: Schema.Codec<A, I>,
		build: (db: Kysely<Tables>) => Compilable<O> & Fits<O, I>,
	) =>
		Effect.gen(function* () {
			const sql = yield* client
			const query = build(kysely).compile()
			const raw = yield* sql.unsafe(query.sql, query.parameters)
			return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(raw).pipe(
				Effect.orDie,
			)
		})

	return {
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
