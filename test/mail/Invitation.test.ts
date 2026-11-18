import { BunServices } from '@effect/platform-bun'
import { expect, it, suite } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer, Option } from 'effect'
import { layerStoreMemory, make, RateLimiter } from 'effect/persistence/RateLimiter'

import {
	EmailDelivery,
	invitationMail,
	invitationTask,
	type LoadedInvitation,
	MailCapture,
	Mailer,
} from '../../src/mail/index.ts'
import type { JobInfo } from '../../src/worker/index.ts'

const template = `<mjml><mj-body><mj-section><mj-column><mj-text>[[inviterName]] invites you to the [[group]] [[groupName]]: [[link]]</mj-text></mj-column></mj-section></mj-body></mjml>`

const Delivery = EmailDelivery.layer({
	kinds: [invitationMail],
	templates: { 'invitation.mjml': template },
	brand: { projectName: 'Stomp', legalText: 'Legal' },
}).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			Mailer.layerCapture,
			Layer.effect(RateLimiter, make).pipe(Layer.provide(layerStoreMemory)),
			BunServices.layer,
		).pipe(Layer.provideMerge(MailCapture.layer)),
	),
)

const info: JobInfo = {
	job: {
		id: '1',
		task_identifier: 'band_invitations__send_invite',
		attempts: 1,
		created_at: new Date(0),
	},
	abortSignal: new AbortController().signal,
}

const stored: Record<string, LoadedInvitation> = {
	'inv 1': {
		email: Option.some('new@example.invalid'),
		code: Option.some('a+b/c'),
		groupName: 'The Pedals',
		inviterName: Option.some('Ann'),
	},
	'inv 2': {
		email: Option.some('known@example.invalid'),
		code: Option.none(),
		groupName: 'The Pedals',
		inviterName: Option.none(),
	},
	'inv 3': {
		email: Option.none(),
		code: Option.none(),
		groupName: 'The Pedals',
		inviterName: Option.none(),
	},
}

/** Runs the task on one payload and returns the mail it sent. */
const run = (payload: unknown) =>
	Effect.gen(function* () {
		const context = yield* Effect.context<EmailDelivery>()
		const loaded: Array<string> = []
		const task = invitationTask({
			job: 'band_invitations__send_invite',
			group: 'band',
			acceptPath: '/invitations/accept',
			rootUrl: Config.String('ROOT_URL'),
			load: (id) =>
				Effect.sync(() => {
					loaded.push(id)
					return Option.fromNullishOr(stored[id])
				}),
		})(context)
		yield* Effect.promise(() => task(payload, info))
		const capture = yield* MailCapture
		return { loaded, sent: yield* capture.sent }
	}).pipe(
		Effect.provide(
			Layer.merge(
				Delivery,
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({ ROOT_URL: 'https://stomp.invalid//' }),
				),
			),
		),
	)

suite('invitationTask', () => {
	it.live('mails an address with no account its code in the fragment', () =>
		Effect.gen(function* () {
			const { loaded, sent } = yield* run({ id: 'inv 1' })
			expect(loaded).toEqual(['inv 1'])
			expect(sent).toHaveLength(1)
			const [message] = sent
			expect(message?.to).toEqual(['new@example.invalid'])
			expect(message?.subject).toBe('You have been invited to The Pedals')
			expect(message?.text).toContain(
				'Ann invites you to the band The Pedals: https://stomp.invalid/invitations/accept?id=inv%201#token=a%2Bb%2Fc',
			)
		}),
	)

	it.live('mails an existing account a link with no token', () =>
		Effect.gen(function* () {
			const { sent } = yield* run({ id: 'inv 2' })
			expect(sent).toHaveLength(1)
			expect(sent[0]?.text).toContain(
				'https://stomp.invalid/invitations/accept?id=inv%202',
			)
			expect(sent[0]?.text).not.toContain('#')
		}),
	)

	it.live('succeeds without sending when the invitation is gone', () =>
		Effect.gen(function* () {
			const { loaded, sent } = yield* run({ id: 'gone' })
			expect(loaded).toEqual(['gone'])
			expect(sent).toHaveLength(0)
		}),
	)

	it.live('succeeds without sending when the invitation has no address', () =>
		Effect.gen(function* () {
			const { sent } = yield* run({ id: 'inv 3' })
			expect(sent).toHaveLength(0)
		}),
	)

	it.live('rejects a payload with no id before loading', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(run({ nope: 1 }))
			expect(exit._tag).toBe('Failure')
		}),
	)
})
