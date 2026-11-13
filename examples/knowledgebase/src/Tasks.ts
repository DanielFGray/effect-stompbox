import { mapSqlState } from '@danielfgray/stompbox/db'
import { visitorDb } from '@danielfgray/stompbox/visitor'
import { Context, Effect, Layer, Option } from 'effect'
import { sql } from 'kysely'

import { Task, TaskNotFound, type TaskStatus } from './Api.ts'
// What the visitor may reach, generated from the database (step 2b). A table
// or column the visitor has no grant on is not in this type, so a query on it
// does not compile.
import type { VisitorTables } from './generated/visitor.ts'

const db = visitorDb<VisitorTables>()

/**
 * The signed-in user's tasks. No query names the user: the request runs as
 * the visitor, and the `own_tasks` policy limits every statement to the rows
 * of `auth.current_user_id()`.
 */
export class Tasks extends Context.Service<Tasks>()('knowledgebase/Tasks', {
	make: Effect.succeed({
		list: Effect.fn('Tasks.list')(function* (status: Option.Option<TaskStatus>) {
			return yield* db.all(Task, (k) => {
				const all = k
					.selectFrom('app_public.tasks')
					.selectAll()
					.orderBy('created_at', 'desc')
				return Option.match(status, {
					onNone: () => all,
					onSome: (s) => all.where('status', '=', s),
				})
			})
		}, mapSqlState({})),

		create: Effect.fn('Tasks.create')(function* (title: string, dueDate: Date | null) {
			return yield* db.one(Task, (k) =>
				k
					.insertInto('app_public.tasks')
					.values({ title, due_date: dueDate })
					.returningAll(),
			)
		}, mapSqlState({})),

		// Another user's task is not found either: the policy hides it.
		complete: Effect.fn('Tasks.complete')(function* (taskId: string) {
			const task = yield* db.maybe(Task, (k) =>
				k
					.updateTable('app_public.tasks')
					.set({ status: 'completed', completed_at: sql`now()` })
					.where('id', '=', taskId)
					.returningAll(),
			)
			return yield* Effect.fromOption(task, () => new TaskNotFound({ taskId }))
		}, mapSqlState({})),
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
