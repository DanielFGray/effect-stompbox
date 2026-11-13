// The contract the browser and the server share. It imports only the
// client-safe part of the auth package.
// InvalidCredentials and AccountLocked come from the auth package, so every
// app answers a failed sign-in the same way.
import {
	AccountLocked,
	InvalidCredentials,
	SignedIn,
} from '@danielfgray/stompbox/auth/api'
import { Schema } from 'effect'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

export const Account = Schema.Struct({ id: Schema.String, username: Schema.String })

export const TaskStatus = Schema.Literals(['open', 'completed'])
export type TaskStatus = typeof TaskStatus.Type

export const Task = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	status: TaskStatus,
	due_date: Schema.NullOr(Schema.Date),
	completed_at: Schema.NullOr(Schema.Date),
	created_at: Schema.Date,
})

const Credentials = Schema.Struct({
	username: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(64)),
	password: Schema.String.check(Schema.isMinLength(8)),
})

export class UsernameTaken extends Schema.TaggedError<
	UsernameTaken,
	{ readonly brand: unique symbol }
>()('UsernameTaken', {}, { httpApiStatus: 409 }) {}

export class TaskNotFound extends Schema.TaggedError<
	TaskNotFound,
	{ readonly brand: unique symbol }
>()('TaskNotFound', { taskId: Schema.String }, { httpApiStatus: 404 }) {}

const Public = HttpApiGroup.make('public')
	.add(
		HttpApiEndpoint.post('register', '/register', {
			payload: Credentials,
			success: Account,
			error: UsernameTaken,
		}),
	)
	.add(
		HttpApiEndpoint.post('signIn', '/sign-in', {
			payload: Credentials,
			success: Account,
			error: [InvalidCredentials, AccountLocked],
		}),
	)

// SignedIn answers 401 without a live session, so an endpoint added here is
// private by default.
const Private = HttpApiGroup.make('private')
	.add(HttpApiEndpoint.post('signOut', '/sign-out'))
	.add(HttpApiEndpoint.get('me', '/me', { success: Account }))
	.add(
		HttpApiEndpoint.get('listTasks', '/tasks', {
			query: Schema.Struct({ status: Schema.optionalKey(TaskStatus) }),
			success: Schema.Array(Task),
		}),
	)
	.add(
		HttpApiEndpoint.post('createTask', '/tasks', {
			payload: Schema.Struct({
				title: Schema.String,
				due_date: Schema.NullOr(Schema.Date),
			}),
			success: Task,
		}),
	)
	.add(
		HttpApiEndpoint.post('completeTask', '/tasks/:id/complete', {
			params: Schema.Struct({ id: Schema.String }),
			success: Task,
			error: TaskNotFound,
		}),
	)
	.middleware(SignedIn)

export class KnowledgebaseApi extends HttpApi.make('knowledgebase')
	.add(Public)
	.add(Private)
	.prefix('/api') {}
