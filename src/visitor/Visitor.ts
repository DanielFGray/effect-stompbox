import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'

import { c1, c2, Finding, roleContract } from '../checker/index.ts'
import { Features, versionsBehind } from '../delivery/index.ts'
import { ApiPool } from './Pools.ts'

/**
 * The current request's session id, or none for an anonymous request. The
 * auth implementation provides it per request (ADR 0004); `Visitor.run` reads
 * it and binds it to `my.session_id` for `current_user_id()`.
 */
export class RequestSession extends Context.Service<
	RequestSession,
	Option.Option<string>
>()('@danielfgray/stompbox/visitor/RequestSession') {}

/**
 * The request's transaction, as the visitor role. Only `Visitor.run` provides
 * it, so code that queries as the visitor cannot run outside a request: it
 * does not compile. Request code queries through `visitorDb`, or through
 * `sql` for a statement Kysely cannot build.
 *
 * A service method that queries as the visitor requires it from its caller,
 * the way a handler requires the request: it exists only per request.
 *
 * @effect-leakable-service
 */
export class VisitorTransaction extends Context.Service<
	VisitorTransaction,
	{ readonly sql: SqlClient }
>()('@danielfgray/stompbox/visitor/VisitorTransaction') {}

/** The database's roles do not meet the role contract; the server does not start. */
export class StartupCheckFailed extends Schema.TaggedError<
	StartupCheckFailed,
	{ readonly brand: unique symbol }
>()('StartupCheckFailed', { findings: Schema.Array(Finding) }) {}

/** A defect: `Visitor.run` was called inside `Visitor.run`. */
export class NestedVisitorRun extends Schema.TaggedError<
	NestedVisitorRun,
	{ readonly brand: unique symbol }
>()('NestedVisitorRun', {}) {}

/**
 * Runs request code as the visitor role. Building the layer checks the role
 * contract (checks C1 and C2, and that the API pool logs in as the API login)
 * and that no feature in `Features` is behind its latest migration, and fails
 * with `StartupCheckFailed` otherwise.
 */
export class Visitor extends Context.Service<
	Visitor,
	{
		/**
		 * Runs `effect` in one transaction on the API pool, as the visitor role,
		 * with the request's session bound to `my.session_id`. `effect` reaches
		 * that transaction through `VisitorTransaction`, which only this provides.
		 * A nested `sql.withTransaction` inside it is a savepoint.
		 *
		 * Database errors leave it unmapped; pipe the result through
		 * `mapSqlState`, which then runs after the rollback.
		 *
		 * A fiber forked inside `effect` that queries after `run` returns gets a
		 * connection error, never another request's transaction: the Postgres
		 * driver refuses statements on a released connection lease. The escape
		 * tests in test/Visitor.test.ts hold the driver to that.
		 */
		readonly run: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | SqlError, Exclude<R, VisitorTransaction> | RequestSession>
	}
>()('@danielfgray/stompbox/visitor/Visitor') {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const api = yield* ApiPool
			const roles = yield* startupCheck.pipe(Effect.provideService(SqlClient, api))
			const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.gen(function* () {
					// An open transaction on the API pool means a request is already running;
					// `afterCommit` callbacks run without it, so they may start a new one.
					if (Option.isSome(yield* Effect.serviceOption(api.transactionService)))
						return yield* Effect.die(new NestedVisitorRun())
					const session = yield* RequestSession
					return yield* api.withTransaction(
						Effect.gen(function* () {
							yield* api`select set_config('role', ${roles.visitor}, true),
							                  set_config('my.session_id', ${Option.getOrElse(session, () => '')}, true)`
							return yield* effect.pipe(
								Effect.provideService(VisitorTransaction, { sql: api }),
							)
						}),
					)
				})
			const features = yield* Features
			const behind = yield* run(
				Effect.flatMap(VisitorTransaction, ({ sql }) =>
					versionsBehind(features).pipe(Effect.provideService(SqlClient, sql)),
				),
			).pipe(Effect.provideService(RequestSession, Option.none()))
			if (behind.length > 0) return yield* new StartupCheckFailed({ findings: behind })
			return { run }
		}),
	)
}

/** Checks the role contract with the API pool and returns the roles requests use. */
const startupCheck = Effect.gen(function* () {
	const sql = yield* SqlClient
	const roles = yield* roleContract
	const [login] = yield* sql`select session_user as name`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ name: Schema.String })])),
		),
	)
	const wrongLogin =
		login.name === roles.api
			? []
			: [
					new Finding({
						level: 'error',
						check: 'session_user',
						object: `login ${login.name}`,
						problem: `the API pool logs in as ${login.name}, not as ${roles.api}`,
						rule: 'The API pool connects as the API login.',
					}),
				]
	const [api, visitorFindings] = yield* Effect.all([c1(roles), c2(roles)])
	const errors = [...wrongLogin, ...api, ...visitorFindings].filter(
		(f) => f.level === 'error',
	)
	if (errors.length > 0) return yield* new StartupCheckFailed({ findings: errors })
	return roles
})
