import { Effect } from 'effect'

import { runnerOn } from '../db/index.ts'
import { OwnerPool } from './Pools.ts'
import { VisitorTransaction } from './Visitor.ts'

/**
 * Queries as the visitor, typed by `Tables`. Each method needs
 * `VisitorTransaction`, which only `Visitor.run` provides, so a visitor query
 * outside a request does not compile.
 */
export const visitorDb = <Tables>() =>
	runnerOn<Tables, VisitorTransaction>(
		Effect.map(Effect.service(VisitorTransaction), (t) => t.sql),
	)

/**
 * Queries as the owner, typed by `Tables`. Row-level security does not limit
 * the owner, so only code that asks for `OwnerPool` by name can run these.
 * `withTransaction` runs an effect in one owner transaction; every owner query
 * inside it, from this runner or from another service on `OwnerPool`, joins it.
 */
export const ownerDb = <Tables>() => {
	const db = runnerOn<Tables, OwnerPool>(Effect.service(OwnerPool))
	return {
		...db,
		withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.flatMap(Effect.service(OwnerPool), (sql) => sql.withTransaction(effect)),
	}
}
