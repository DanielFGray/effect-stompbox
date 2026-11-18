import { BunServices } from '@effect/platform-bun'
import { expect, it, suite } from '@effect/vitest'
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from 'effect'
import { layerStoreMemory, make, RateLimiter } from 'effect/persistence/RateLimiter'

import {
	EmailDelivery,
	MailCapture,
	Mailer,
	mailKind,
	mailProvider,
	MailTemplateError,
	queuedEmail,
} from '../../src/mail/index.ts'

const mjmlPage = (body: string) =>
	`<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`

const verify = mailKind('verify.mjml', {
	verifyLink: Schema.String,
	token: Schema.String,
})
const notice = mailKind('notice.mjml', { what: Schema.String }, { notice: true })
const kinds = [verify, notice]

const templates = {
	'verify.mjml': mjmlPage(
		'Hi from [[projectName]]: [[token]] [[verifyLink]] [[legalText]]',
	),
	'notice.mjml': mjmlPage('Notice: [[what]]'),
}
const brand = { projectName: 'Stomp', legalText: 'Legal & co' }

const Limiter = Layer.effect(RateLimiter, make).pipe(Layer.provide(layerStoreMemory))

const verifyJob = (to: string | readonly [string, ...string[]]) => ({
	options: { to, subject: 'Verify' },
	template: 'verify.mjml',
	variables: { verifyLink: 'https://example.invalid/verify#token=abc', token: 'abc' },
})

/** A capture Mailer and the delivery over it, for one test. */
const deliveryWith = (options: {
	readonly templates?: string | { readonly [template: string]: string }
}) =>
	EmailDelivery.layer({
		kinds,
		templates: options.templates ?? templates,
		brand,
	})

const send = (job: ReturnType<typeof verifyJob>) =>
	EmailDelivery.use((delivery) => delivery.send(job))

suite('EmailDelivery', () => {
	it.live('substitutes escaped variables and makes a text part', () =>
		Effect.gen(function* () {
			const capture = yield* MailCapture
			const delivery = yield* EmailDelivery
			yield* delivery.send(verifyJob('player@example.invalid'))
			const [message] = yield* capture.sent
			expect(message?.to).toEqual(['player@example.invalid'])
			expect(message?.subject).toBe('Verify')
			expect(message?.html).toContain('Hi from Stomp')
			expect(message?.html).toContain('Legal &amp; co')
			expect(message?.html).toContain('https://example.invalid/verify#token=abc')
			expect(message?.text).toContain('Hi from Stomp: abc')
			expect(message?.text).not.toContain('<')
		}).pipe(
			Effect.provide(
				Layer.provideMerge(
					deliveryWith({}),
					Layer.mergeAll(Mailer.layerCapture, Limiter, BunServices.layer).pipe(
						Layer.provideMerge(MailCapture.layer),
					),
				),
			),
		),
	)

	it.live('reads templates from a directory', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const dir = yield* fs.makeTempDirectoryScoped()
			yield* Effect.forEach(Object.entries(templates), ([name, source]) =>
				fs.writeFileString(`${dir}/${name}`, source),
			)
			const context = yield* Layer.build(
				deliveryWith({ templates: dir }).pipe(
					Layer.provide(Layer.mergeAll(Mailer.layerCapture, Limiter, BunServices.layer)),
					Layer.provide(MailCapture.layer),
				),
			)
			yield* send(verifyJob('a@example.invalid')).pipe(Effect.provide(context))
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
	)

	const failing = (
		name: string,
		options: Parameters<typeof deliveryWith>[0],
		message: string,
	) =>
		it.live(name, () =>
			Effect.gen(function* () {
				const error = yield* Layer.build(
					deliveryWith(options).pipe(
						Layer.provide(
							Layer.mergeAll(Mailer.layerCapture, Limiter, BunServices.layer),
						),
						Layer.provide(MailCapture.layer),
					),
				).pipe(Effect.flip, Effect.scoped)
				expect(error).toBeInstanceOf(MailTemplateError)
				expect(error.message).toContain(message)
			}),
		)

	failing(
		'fails the layer when a declared template is missing from the map',
		{ templates: { 'verify.mjml': templates['verify.mjml'] } },
		'no source',
	)
	failing(
		'fails the layer when a declared template is missing from the directory',
		{ templates: '/nonexistent-stompbox-templates' },
		'Could not read',
	)
	failing(
		'fails the layer when a template is invalid MJML',
		{
			templates: {
				...templates,
				'notice.mjml': '<mjml><mj-body><mj-bogus /></mj-body></mjml>',
			},
		},
		'mj-bogus',
	)
	failing(
		'fails the layer when a template reads a variable its kind does not declare',
		{ templates: { ...templates, 'notice.mjml': mjmlPage('[[what]] [[undeclared]]') } },
		'does not declare',
	)

	it.live('drops a recipient after five mails an hour; notices are exempt', () =>
		Effect.gen(function* () {
			const capture = yield* MailCapture
			const delivery = yield* EmailDelivery
			for (let i = 0; i < 5; i++)
				yield* delivery.send(verifyJob('player@example.invalid'))
			yield* delivery.send(verifyJob('PLAYER@example.invalid'))
			yield* delivery.send(verifyJob(['player@example.invalid', 'fresh@example.invalid']))
			yield* delivery.send({
				options: { to: 'player@example.invalid', subject: 'Notice' },
				template: 'notice.mjml',
				variables: { what: 'password changed' },
			})
			const delivered = yield* capture.sent
			expect(delivered.map((mail) => mail.to)).toEqual([
				...Array.from({ length: 5 }, () => ['player@example.invalid']),
				['fresh@example.invalid'],
				['player@example.invalid'],
			])
		}).pipe(
			Effect.provide(
				Layer.provideMerge(
					deliveryWith({}),
					Layer.mergeAll(Mailer.layerCapture, Limiter, BunServices.layer).pipe(
						Layer.provideMerge(MailCapture.layer),
					),
				),
			),
		),
	)

	it.live('sends every mail with `cap: false`, and needs no RateLimiter', () =>
		Effect.gen(function* () {
			const capture = yield* MailCapture
			const delivery = yield* EmailDelivery
			for (let i = 0; i < 7; i++)
				yield* delivery.send(verifyJob('player@example.invalid'))
			expect(yield* capture.sent).toHaveLength(7)
		}).pipe(
			Effect.provide(
				Layer.provideMerge(
					EmailDelivery.layer({ kinds, templates, brand, cap: false }),
					Layer.mergeAll(Mailer.layerCapture, BunServices.layer).pipe(
						Layer.provideMerge(MailCapture.layer),
					),
				),
			),
		),
	)

	it.effect('decodes a queued payload against the declared kinds', () =>
		Effect.gen(function* () {
			const payload = queuedEmail(kinds)
			const ok = yield* Schema.decodeEffect(payload)(verifyJob('a@example.invalid'))
			expect(ok.template).toBe('verify.mjml')
			const error = yield* Schema.decodeEffect(payload)({
				...verifyJob('a@example.invalid'),
				variables: { token: 'only-token' },
			}).pipe(Effect.flip)
			expect(Schema.isSchemaError(error)).toBe(true)
		}),
	)
})

suite('mail provider selection', () => {
	const select = (env: Record<string, string>) =>
		mailProvider.pipe(
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
		)

	it.effect('defaults by NODE_ENV when MAIL_PROVIDER is unset', () =>
		Effect.gen(function* () {
			expect(yield* select({ NODE_ENV: 'development' })).toBe('ethereal')
			expect(yield* select({ NODE_ENV: 'test' })).toBe('capture')
			expect(yield* select({ NODE_ENV: 'production' })).toBe('cloudflare')
			expect(yield* select({ NODE_ENV: 'production', MAIL_PROVIDER: 'capture' })).toBe(
				'capture',
			)
		}),
	)
})
