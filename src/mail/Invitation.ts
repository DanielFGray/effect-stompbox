import { type Config, type Context, Effect, Option, Schema } from 'effect'

import { effectTask } from '../worker/Job.ts'
import { EmailDelivery, mailKind } from './EmailDelivery.ts'

/**
 * The mail kind of every invitation. The app supplies one MJML template named
 * `invitation.mjml`, which reads these variables:
 *
 * - `group`: the app's word for the group (`family`, `band`, `organization`).
 * - `groupName`: the name of that group.
 * - `inviterName`: who invited, or null when the invitation has no inviter.
 * - `link`: the accept link.
 */
export const invitationMail = mailKind('invitation.mjml', {
	group: Schema.String,
	groupName: Schema.String,
	inviterName: Schema.NullOr(Schema.String),
	link: Schema.String,
})

/** An invitation as the app's loader reads it from its own tables. */
export interface LoadedInvitation {
	/** Where to send it. None when an invitation to an account finds that account with no address. */
	readonly email: Option.Option<string>
	/**
	 * The secret that proves its reader was sent the mail. An invitation to an
	 * address that has no account has one; an invitation to an existing account
	 * has none, because the account's login proves the reader.
	 */
	readonly code: Option.Option<string>
	readonly groupName: string
	readonly inviterName: Option.Option<string>
}

export interface InvitationTaskOptions<E, R> {
	/** The task name the app's SQL trigger queues, such as `band_invitations__send_invite`. */
	readonly job: string
	/** The app's word for the group, which the template reads as `group`. */
	readonly group: string
	/** The path of the app's accept page, such as `/invitations/accept`. */
	readonly acceptPath: string
	/** The origin the link starts with, such as `https://example.com`. Trailing slashes are dropped. */
	readonly rootUrl: Config.Config<string>
	/**
	 * Reads the invitation, its group and its inviter from the app's tables.
	 * None means the invitation is gone: it was accepted or declined before the
	 * job ran.
	 */
	readonly load: (id: string) => Effect.Effect<Option.Option<LoadedInvitation>, E, R>
}

/** The payload the app's SQL trigger queues: the invitation's id. */
export const InvitationPayload = Schema.Struct({ id: Schema.String })

/**
 * The task that mails an invitation. The app passes it where its other tasks
 * go, keyed by `options.job`:
 *
 * ```ts
 * [options.job]: invitationTask(options)(context)
 * ```
 *
 * The job decodes `{ id }`, loads the invitation, and sends `invitationMail`
 * through `EmailDelivery`. It succeeds without sending when the invitation is
 * gone or has no address: a retry would find the same.
 *
 * The link is `<rootUrl><acceptPath>?id=<id>#token=<code>`. The code travels
 * in the fragment, which no HTTP request carries, so it stays out of server
 * logs and `Referer`. An invitation with no code has no fragment.
 */
export const invitationTask =
	<E, R>(options: InvitationTaskOptions<E, R>) =>
	(context: Context.Context<R | EmailDelivery>) =>
		effectTask(context)(InvitationPayload, ({ id }) =>
			options.load(id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.logInfo(`Invitation ${id} not found: nothing to send`),
						onSome: (invitation) =>
							Option.match(invitation.email, {
								onNone: () =>
									Effect.logWarning(
										`Invitation ${id} has no address to send to: nothing to send`,
									),
								onSome: (email) => send(options, id, email, invitation),
							}),
					}),
				),
			),
		)

const send = Effect.fnUntraced(function* <E, R>(
	options: InvitationTaskOptions<E, R>,
	id: string,
	email: string,
	invitation: LoadedInvitation,
) {
	const rootUrl = (yield* options.rootUrl).replace(/\/+$/, '')
	const fragment = Option.match(invitation.code, {
		onNone: () => '',
		onSome: (code) => `#token=${encodeURIComponent(code)}`,
	})
	const delivery = yield* EmailDelivery
	yield* delivery.send({
		options: { to: email, subject: `You have been invited to ${invitation.groupName}` },
		template: invitationMail.template,
		variables: {
			group: options.group,
			groupName: invitation.groupName,
			// Template variables are plain values: MJML placeholders have no Option.
			inviterName: Option.getOrNull(invitation.inviterName),
			link: `${rootUrl}${options.acceptPath}?id=${encodeURIComponent(id)}${fragment}`,
		},
	})
})
