import { c1, c2, Finding, RoleContract, roleContract } from '@effect-backend/checker'
import { Config, Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'

import { ApiPool } from './Pools.ts'

/**
 * The current request's session id, or none for an anonymous request. The
 * auth implementation provides it per request (ADR 0004); `Visitor.run` reads
 * it and binds it to `my.session_id` for `current_user_id()`.
 */
export class RequestSession extends Context.Service<
	RequestSession,
	Option.Option<string>
>()('@effect-backend/visitor/RequestSession') {}

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
 * and fails with `StartupCheckFailed` when the roles are wrong.
 */
export class Visitor extends Context.Service<
	Visitor,
	{
		/**
		 * Runs `effect` in one transaction on the API pool, as the visitor role,
		 * with the request's session bound to `my.session_id`. Every query
		 * `effect` runs through `SqlClient` joins that transaction.
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
		) => Effect.Effect<A, E | SqlError, Exclude<R, SqlClient> | RequestSession>
	}
>()('@effect-backend/visitor/Visitor') {
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
							return yield* effect.pipe(Effect.provideService(SqlClient, api))
						}),
					)
				})
			return { run }
		}),
	)
}

/**
 * Checks the role contract with the API pool and returns the roles requests
 * use. The visitor role's name follows from the database name unless
 * `DATABASE_VISITOR` overrides it; the checks then run on that role.
 */
const startupCheck = Effect.gen(function* () {
	const sql = yield* SqlClient
	const derived = yield* roleContract
	const visitor = yield* Config.option(Config.String('DATABASE_VISITOR'))
	const roles = new RoleContract({
		owner: derived.owner,
		api: derived.api,
		visitor: Option.getOrElse(visitor, () => derived.visitor),
	})
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
