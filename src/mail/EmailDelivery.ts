import {
	Array as Arr,
	Cause,
	Context,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Predicate,
	Path,
	Record,
	Schema,
} from 'effect'
import { RateLimiter, type RateLimiterError } from 'effect/persistence/RateLimiter'
import { convert } from 'html-to-text'
import template from 'lodash.template'

import { type MailDeliveryError, Mailer, MailMessage } from './Mailer.ts'

/** What a template variable can hold: text, or a value that prints as text. */
export const MailValue = Schema.Union([
	Schema.String,
	Schema.Finite,
	Schema.Boolean,
	Schema.Null,
])
export type MailValue = typeof MailValue.Type

const MailOptions = Schema.Struct({
	to: Schema.Union([Schema.NonEmptyString, Schema.NonEmptyArray(Schema.NonEmptyString)]),
	subject: Schema.String,
})

/** The payload of a `send_email` job, as `EmailDelivery.send` takes it. */
export const MailJob = Schema.Struct({
	options: MailOptions,
	template: Schema.String,
	variables: Schema.Record(Schema.String, MailValue),
})
export type MailJob = typeof MailJob.Type

/**
 * One kind of mail: the template it renders and the variables that template
 * reads. `schema` decodes the job payload for that kind. A notice is exempt
 * from the per-address cap: only an action on the account sends one, and a
 * flood that used up the cap first would hide the notice of the attack.
 */
export interface MailKind {
	readonly template: string
	readonly variables: ReadonlyArray<string>
	readonly notice: boolean
	readonly schema: Schema.Decoder<MailJob>
}

/**
 * Declares a mail kind. `template` is the name the app's templates use (a file
 * name, or a key of the template map); `variables` are the fields of that
 * template's `[[placeholders]]`.
 */
export const mailKind = <
	const T extends string,
	const F extends { readonly [name: string]: Schema.Codec<MailValue, MailValue> },
>(
	template: T,
	variables: F,
	options?: { readonly notice?: boolean },
) =>
	({
		template,
		variables: Object.keys(variables),
		notice: options?.notice ?? false,
		schema: Schema.Struct({
			options: MailOptions,
			template: Schema.Literal(template),
			variables: Schema.Struct(variables),
		}),
	}) satisfies MailKind

/** The schema of the `send_email` payload: any of `kinds`. */
export const queuedEmail = (kinds: ReadonlyArray<MailKind>) =>
	Schema.Union(kinds.map((kind) => kind.schema))

/** A template that is missing, does not compile, or does not render. */
export class MailTemplateError extends Schema.TaggedError<
	MailTemplateError,
	{ readonly brand: unique symbol }
>()('MailTemplateError', {
	template: Schema.String,
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export type EmailDeliveryOptions = {
	readonly kinds: ReadonlyArray<MailKind>
	/** A directory of MJML files named by `MailKind.template`, or a map from that name to MJML source. */
	readonly templates: string | { readonly [template: string]: string }
	/** Brand text every template can read as `[[projectName]]` and `[[legalText]]`. */
	readonly brand: { readonly projectName: string; readonly legalText: string }
}

export type MailCap = {
	readonly limit?: number
	readonly window?: Duration.Input
}

const defaultCap = { limit: 5, window: Duration.hours(1) } as const

/** The longest a send waits for the cap's store; a store that is down fails the job for a retry. */
const storeTimeout = Duration.seconds(1)

/**
 * Delivers the `send_email` jobs: renders the kind's MJML template and sends
 * it through the Mailer. The layer compiles every declared template with
 * strict validation when it builds, so a missing or invalid template stops the
 * worker at start, not a send. A recipient over the per-address cap is
 * dropped with a warning and the job still succeeds: a failed job would be
 * retried and the mail sent later anyway. When the cap cannot be checked, the
 * job fails so that graphile-worker retries it.
 *
 * It has no `make`: it takes the app's kinds and templates.
 */
export class EmailDelivery extends Context.Service<
	EmailDelivery,
	{
		readonly send: (
			job: MailJob,
		) => Effect.Effect<
			void,
			MailTemplateError | MailDeliveryError | RateLimiterError | Cause.TimeoutError
		>
	}
>()('@danielfgray/stompbox/mail/EmailDelivery') {
	/** With the per-address cap: 5 mails per hour by default, counted in the app's `RateLimiter`. */
	static layer(
		options: EmailDeliveryOptions & { readonly cap?: MailCap },
	): Layer.Layer<
		EmailDelivery,
		MailTemplateError,
		Mailer | RateLimiter | FileSystem.FileSystem | Path.Path
	>
	/** With no cap, and no `RateLimiter` needed. */
	static layer(
		options: EmailDeliveryOptions & { readonly cap: false },
	): Layer.Layer<
		EmailDelivery,
		MailTemplateError,
		Mailer | FileSystem.FileSystem | Path.Path
	>
	static layer(options: EmailDeliveryOptions & { readonly cap?: MailCap | false }) {
		return Layer.effect(EmailDelivery, make(options))
	}
}

const make = Effect.fnUntraced(function* (
	options: EmailDeliveryOptions & { readonly cap?: MailCap | false },
) {
	const mailer = yield* Mailer
	const limiter = options.cap === false ? Option.none() : Option.some(yield* RateLimiter)
	const cap = { ...defaultCap, ...options.cap }
	const loaded = yield* loadSources(options)
	const mjml = yield* Effect.tryPromise({
		try: () => import('mjml').then((module) => module.default),
		catch: (cause) =>
			new MailTemplateError({
				template: '',
				message: 'Could not load mjml, an optional peer dependency of the mail subpath',
				cause,
			}),
	})
	const render = Effect.fnUntraced(function* (
		name: string,
		source: string,
		variables: { readonly [name: string]: MailValue },
	) {
		const document = yield* Effect.try({
			try: () =>
				template(source, { escape: /\[\[([\s\S]+?)\]\]/g })({
					...options.brand,
					...variables,
				}),
			catch: (cause) =>
				new MailTemplateError({
					template: name,
					message:
						'The template reads a variable that its kind does not declare, or is malformed',
					cause,
				}),
		})
		const rendered = yield* Effect.tryPromise({
			try: () => mjml(document, { validationLevel: 'strict' }),
			catch: (cause) =>
				new MailTemplateError({
					template: name,
					message: `MJML could not compile it: ${Predicate.isError(cause) ? cause.message : String(cause)}`,
					cause,
				}),
		})
		if (rendered.errors.length > 0) {
			return yield* new MailTemplateError({
				template: name,
				message: rendered.errors.map((error) => error.formattedMessage).join('\n'),
				cause: rendered.errors,
			})
		}
		return {
			html: rendered.html,
			text: convert(rendered.html.replace(/(<\/?)div/g, '$1p'), {
				wordwrap: 120,
			}).replace(/\n\s+\n/g, '\n\n'),
		}
	})

	// Every declared template must compile now, with a sample for each variable.
	yield* Effect.forEach(loaded, ({ kind, source }) =>
		render(
			kind.template,
			source,
			Object.fromEntries(kind.variables.map((name) => [name, `sample ${name}`])),
		),
	)

	/** The job's recipients that are still under the per-address cap. */
	const withinCap = Effect.fnUntraced(function* (job: MailJob, notice: boolean) {
		const to = typeof job.options.to === 'string' ? [job.options.to] : job.options.to
		if (notice || Option.isNone(limiter)) return to
		return yield* Effect.filter(to, (address) =>
			limiter.value
				.consume({
					key: `recipient:${address.toLowerCase()}`,
					limit: cap.limit,
					window: cap.window,
					onExceeded: 'fail',
				})
				.pipe(
					Effect.timeout(storeTimeout),
					Effect.as(true),
					Effect.catchReason('RateLimiterError', 'RateLimitExceeded', () =>
						Effect.logWarning(
							`Dropped ${job.template}: ${address} is over ${cap.limit} mails per ${Duration.format(Duration.fromInputUnsafe(cap.window))}`,
						).pipe(Effect.as(false)),
					),
				),
		)
	})

	return EmailDelivery.of({
		send: Effect.fn('EmailDelivery.send')(function* (job: MailJob) {
			const found = Arr.findFirst(loaded, ({ kind }) => kind.template === job.template)
			if (Option.isNone(found)) {
				return yield* new MailTemplateError({
					template: job.template,
					message: 'No mail kind declares this template',
					cause: undefined,
				})
			}
			const recipients = yield* withinCap(job, found.value.kind.notice)
			if (!Arr.isReadonlyArrayNonEmpty(recipients)) return
			const { html, text } = yield* render(
				job.template,
				found.value.source,
				job.variables,
			)
			yield* mailer.send(
				new MailMessage({ to: recipients, subject: job.options.subject, html, text }),
			)
		}),
	})
})

/** Each declared kind with its MJML source, read from the directory or taken from the map. */
const loadSources = Effect.fnUntraced(function* (options: EmailDeliveryOptions) {
	const { templates } = options
	if (typeof templates !== 'string') {
		const entries = yield* Effect.forEach(options.kinds, (kind) =>
			Option.match(Record.get(templates, kind.template), {
				onNone: () =>
					Effect.fail(
						new MailTemplateError({
							template: kind.template,
							message: 'The template map has no source for this kind',
							cause: undefined,
						}),
					),
				onSome: (source) => Effect.succeed({ kind, source }),
			}),
		)
		return entries
	}
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = yield* Effect.forEach(options.kinds, (kind) =>
		fs.readFileString(path.join(templates, kind.template)).pipe(
			Effect.map((source) => ({ kind, source })),
			Effect.mapError(
				(cause) =>
					new MailTemplateError({
						template: kind.template,
						message: `Could not read the template from ${templates}`,
						cause,
					}),
			),
		),
	)
	return entries
})
