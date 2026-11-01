import { VisitorDb } from '@effect-backend/visitor'
import { Context, Effect, Layer, Option } from 'effect'

import { TaskNotFound, type TaskStatus } from './Api.ts'
// What the visitor may reach, generated from the database (step 2b). A table
// or column the visitor has no grant on is not in this type, so a query on it
// does not compile.
import type { VisitorTables } from './generated/visitor.ts'

/**
 * The signed-in user's tasks. No query names the user: the request runs as
 * the visitor, and the `own_tasks` policy limits every statement to the rows
 * of `auth.current_user_id()`.
 */
export class Tasks extends Context.Service<Tasks>()('knowledgebase/Tasks', {
	make: Effect.gen(function* () {
		const db = yield* VisitorDb.of<VisitorTables>()

		const list = Effect.fn('Tasks.list')(function* (status: Option.Option<TaskStatus>) {
			const all = db
				.selectFrom('app_public.tasks')
				.selectAll()
				.orderBy('created_at', 'desc')
			return yield* Option.match(status, {
				onNone: () => all,
				onSome: (s) => all.where('status', '=', s),
			})
		})

		const create = Effect.fn('Tasks.create')(function* (
			title: string,
			dueDate: Date | null,
		) {
			return yield* db
				.insertInto('app_public.tasks')
				.values({ title, due_date: dueDate })
				.returningAll()
				.pipe(Effect.head, Effect.orDie)
		})

		// Another user's task is not found either: the policy hides it.
		const complete = Effect.fn('Tasks.complete')(function* (taskId: string) {
			return yield* db
				.updateTable('app_public.tasks')
				.set({ status: 'completed', completed_at: new Date() })
				.where('id', '=', taskId)
				.returningAll()
				.pipe(
					Effect.head,
					Effect.catchTag('NoSuchElementError', () =>
						Effect.fail(new TaskNotFound({ taskId })),
					),
				)
		})

		return { list, create, complete }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
