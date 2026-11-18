import {
	Array as Arr,
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Match,
	Option,
	Path,
	Redacted,
	Ref,
	Schema,
} from 'effect'
import { createTestAccount, createTransport, getTestMessageUrl } from 'nodemailer'

export class MailMessage extends Schema.Class<
	MailMessage,
	{ readonly brand: unique symbol }
>('MailMessage')({
	to: Schema.NonEmptyArray(Schema.NonEmptyString),
	subject: Schema.String,
	html: Schema.String,
	text: Schema.String,
}) {}

export class MailDeliveryError extends Schema.TaggedError<
	MailDeliveryError,
	{ readonly brand: unique symbol }
>()('MailDeliveryError', {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export class SmtpSettings extends Schema.Class<
	SmtpSettings,
	{ readonly brand: unique symbol }
>('SmtpSettings')({
	host: Schema.String,
	port: Schema.Int,
	secure: Schema.Boolean,
	credentials: Schema.Option(
		Schema.Struct({
			user: Schema.String,
			pass: Schema.Redacted(Schema.String),
		}),
	),
}) {}

export const MailProvider = Schema.Literals(['ethereal', 'capture', 'cloudflare'])
export type MailProvider = typeof MailProvider.Type

/**
 * `MAIL_PROVIDER` when set; otherwise production → cloudflare, test → capture,
 * everything else → ethereal.
 */
export const mailProvider: Config.Config<MailProvider> = Config.all({
	mode: Config.Literals(['development', 'test', 'production'], 'NODE_ENV').pipe(
		Config.withDefault('development' as const),
	),
	configured: Config.schema(MailProvider, 'MAIL_PROVIDER').pipe(Config.option),
}).pipe(
	Config.map(({ mode, configured }) =>
		Option.getOrElse(configured, () =>
			mode === 'production'
				? ('cloudflare' as const)
				: mode === 'test'
					? ('capture' as const)
					: ('ethereal' as const),
		),
	),
)

/**
 * The messages the capture adapter took, oldest first, for tests and testing
 * routes to read. It stays empty under every other adapter.
 */
export class MailCapture extends Context.Service<MailCapture>()(
	'@danielfgray/stompbox/mail/MailCapture',
	{
		make: Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<MailMessage>>([])
			return {
				record: (message: MailMessage) => Ref.update(sent, Arr.append(message)),
				sent: Ref.get(sent),
			} as const
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

/** Sends nothing: each message is kept in `MailCapture`. Declared above `Mailer`, whose static layer reads it. */
const captureMailer = Effect.gen(function* () {
	const capture = yield* MailCapture
	return { send: Effect.fn('Mailer.send')(capture.record) }
})

/**
 * Delivers mail. It has no `make`: an app picks an adapter, and no adapter is
 * the default. `layerConfig` picks one from `MAIL_PROVIDER` or `NODE_ENV`.
 */
export class Mailer extends Context.Service<
	Mailer,
	{
		readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryError>
	}
>()('@danielfgray/stompbox/mail/Mailer') {
	/** SMTP to `settings`, with `from` as the sender. The transport closes with the scope. */
	static readonly layerSmtp = (settings: SmtpSettings, from: string) =>
		Layer.effect(this, smtpMailer(settings, from))

	/** Cloudflare Email Service: SMTP with the user `api_token` and `CLOUDFLARE_EMAIL_API_TOKEN`. */
	static readonly layerCloudflare = (from: string) =>
		Layer.effect(this, cloudflareMailer(from))

	/**
	 * Ethereal's SMTP, for development, with an account kept in `file`
	 * (`ETHEREAL_ACCOUNT_FILE`, else `.ethereal` in the working directory). The
	 * first run creates the account and writes the file.
	 */
	static readonly layerEthereal = (options: {
		readonly from: string
		readonly file?: string
	}) => Layer.effect(this, etherealMailer(options))

	/** Sends nothing: each message is kept in `MailCapture`. */
	static readonly layerCapture = Layer.effect(this, captureMailer)

	/**
	 * The adapter `mailProvider` selects. `EMAIL_FROM` overrides `defaultFrom`.
	 * It also provides the `MailCapture` that `layerCapture` writes.
	 */
	static readonly layerConfig = (options: { readonly defaultFrom: string }) =>
		Layer.effect(
			this,
			Effect.gen(function* () {
				const from = yield* Config.NonEmptyString('EMAIL_FROM').pipe(
					Config.withDefault(options.defaultFrom),
				)
				return yield* Match.value(yield* mailProvider).pipe(
					Match.when('ethereal', () => etherealMailer({ from })),
					Match.when('capture', () => captureMailer),
					Match.when('cloudflare', () => cloudflareMailer(from)),
					Match.exhaustive,
				)
			}),
		).pipe(Layer.provideMerge(MailCapture.layer))
}

const smtpMailer = Effect.fnUntraced(function* (settings: SmtpSettings, from: string) {
	const transport = yield* Effect.acquireRelease(
		Effect.try({
			try: () =>
				createTransport({
					host: settings.host,
					port: settings.port,
					secure: settings.secure,
					auth: Option.getOrUndefined(
						Option.map(settings.credentials, (credentials) => ({
							user: credentials.user,
							pass: Redacted.value(credentials.pass),
						})),
					),
					connectionTimeout: 10_000,
					greetingTimeout: 10_000,
					socketTimeout: 30_000,
				}),
			catch: (cause) =>
				new MailDeliveryError({ message: 'Could not initialize SMTP', cause }),
		}),
		(smtp) => Effect.sync(() => smtp.close()),
	)
	return {
		send: Effect.fn('Mailer.send')(function* (message: MailMessage) {
			const result = yield* Effect.tryPromise({
				try: () =>
					transport.sendMail({
						from,
						to: [...message.to],
						subject: message.subject,
						html: message.html,
						text: message.text,
					}),
				catch: (cause) =>
					new MailDeliveryError({ message: 'SMTP did not accept the email', cause }),
			})
			if (result.rejected.length > 0) {
				return yield* new MailDeliveryError({
					message: 'SMTP rejected one or more recipients',
					cause: result.response,
				})
			}
			const preview = getTestMessageUrl(result)
			if (preview !== false) {
				yield* Effect.logInfo('Development email preview', { url: preview })
			}
		}),
	}
})

const EtherealAccount = Schema.Struct({
	user: Schema.String,
	pass: Schema.RedactedFromValue(Schema.String),
})

const etherealMailer = Effect.fnUntraced(function* (options: {
	readonly from: string
	readonly file?: string
}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const filename = yield* Config.NonEmptyString('ETHEREAL_ACCOUNT_FILE').pipe(
		Config.withDefault(options.file ?? path.resolve('.ethereal')),
	)
	const account = yield* (yield* fs.exists(filename))
		? fs
				.readFileString(filename)
				.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(EtherealAccount))))
		: Effect.gen(function* () {
				const created = yield* Effect.tryPromise({
					try: () => createTestAccount(),
					catch: (cause) =>
						new MailDeliveryError({
							message: 'Could not create the development email account',
							cause,
						}),
				})
				const decoded = yield* Schema.decodeEffect(EtherealAccount)(created)
				const encoded = yield* Schema.encodeEffect(
					Schema.fromJsonString(EtherealAccount),
				)(decoded)
				yield* fs.writeFileString(filename, encoded, { mode: 0o600 })
				return decoded
			})
	return yield* smtpMailer(
		new SmtpSettings({
			host: 'smtp.ethereal.email',
			port: 587,
			secure: false,
			credentials: Option.some(account),
		}),
		options.from,
	)
})

const cloudflareMailer = Effect.fnUntraced(function* (from: string) {
	const token = yield* Config.Redacted('CLOUDFLARE_EMAIL_API_TOKEN')
	return yield* smtpMailer(
		new SmtpSettings({
			host: 'smtp.mx.cloudflare.net',
			port: 465,
			secure: true,
			credentials: Option.some({ user: 'api_token', pass: token }),
		}),
		from,
	)
})
