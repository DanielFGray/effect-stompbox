import { Array as Arr, Cause, Context, Duration, Effect, FileSystem, Layer, Option, Predicate, Path, Record, Schema, } from 'effect';
import { RateLimiter } from 'effect/persistence/RateLimiter';
import { convert } from 'html-to-text';
import template from 'lodash.template';
import { Mailer, MailMessage } from './Mailer.js';
/** What a template variable can hold: text, or a value that prints as text. */
export const MailValue = Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
]);
const MailOptions = Schema.Struct({
    to: Schema.Union([Schema.NonEmptyString, Schema.NonEmptyArray(Schema.NonEmptyString)]),
    subject: Schema.String,
});
/** The payload of a `send_email` job, as `EmailDelivery.send` takes it. */
export const MailJob = Schema.Struct({
    options: MailOptions,
    template: Schema.String,
    variables: Schema.Record(Schema.String, MailValue),
});
/**
 * Declares a mail kind. `template` is the name the app's templates use (a file
 * name, or a key of the template map); `variables` are the fields of that
 * template's `[[placeholders]]`.
 */
export const mailKind = (template, variables, options) => ({
    template,
    variables: Object.keys(variables),
    notice: options?.notice ?? false,
    schema: Schema.Struct({
        options: MailOptions,
        template: Schema.Literal(template),
        variables: Schema.Struct(variables),
    }),
});
/** The schema of the `send_email` payload: any of `kinds`. */
export const queuedEmail = (kinds) => Schema.Union(kinds.map((kind) => kind.schema));
/** A template that is missing, does not compile, or does not render. */
export class MailTemplateError extends Schema.TaggedError()('MailTemplateError', {
    template: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
}) {
}
const defaultCap = { limit: 5, window: Duration.hours(1) };
/** The longest a send waits for the cap's store; a store that is down fails the job for a retry. */
const storeTimeout = Duration.seconds(1);
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
export class EmailDelivery extends Context.Service()('@danielfgray/stompbox/mail/EmailDelivery') {
    static layer(options) {
        return Layer.effect(EmailDelivery, make(options));
    }
}
const make = Effect.fnUntraced(function* (options) {
    const mailer = yield* Mailer;
    const limiter = options.cap === false ? Option.none() : Option.some(yield* RateLimiter);
    const cap = { ...defaultCap, ...options.cap };
    const loaded = yield* loadSources(options);
    const mjml = yield* Effect.tryPromise({
        try: () => import('mjml').then((module) => module.default),
        catch: (cause) => new MailTemplateError({
            template: '',
            message: 'Could not load mjml, an optional peer dependency of the mail subpath',
            cause,
        }),
    });
    const render = Effect.fnUntraced(function* (name, source, variables) {
        const document = yield* Effect.try({
            try: () => template(source, { escape: /\[\[([\s\S]+?)\]\]/g })({
                ...options.brand,
                ...variables,
            }),
            catch: (cause) => new MailTemplateError({
                template: name,
                message: 'The template reads a variable that its kind does not declare, or is malformed',
                cause,
            }),
        });
        const rendered = yield* Effect.tryPromise({
            try: () => mjml(document, { validationLevel: 'strict' }),
            catch: (cause) => new MailTemplateError({
                template: name,
                message: `MJML could not compile it: ${Predicate.isError(cause) ? cause.message : String(cause)}`,
                cause,
            }),
        });
        if (rendered.errors.length > 0) {
            return yield* new MailTemplateError({
                template: name,
                message: rendered.errors.map((error) => error.formattedMessage).join('\n'),
                cause: rendered.errors,
            });
        }
        return {
            html: rendered.html,
            text: convert(rendered.html.replace(/(<\/?)div/g, '$1p'), {
                wordwrap: 120,
            }).replace(/\n\s+\n/g, '\n\n'),
        };
    });
    // Every declared template must compile now, with a sample for each variable.
    yield* Effect.forEach(loaded, ({ kind, source }) => render(kind.template, source, Object.fromEntries(kind.variables.map((name) => [name, `sample ${name}`]))));
    /** The job's recipients that are still under the per-address cap. */
    const withinCap = Effect.fnUntraced(function* (job, notice) {
        const to = typeof job.options.to === 'string' ? [job.options.to] : job.options.to;
        if (notice || Option.isNone(limiter))
            return to;
        return yield* Effect.filter(to, (address) => limiter.value
            .consume({
            key: `recipient:${address.toLowerCase()}`,
            limit: cap.limit,
            window: cap.window,
            onExceeded: 'fail',
        })
            .pipe(Effect.timeout(storeTimeout), Effect.as(true), Effect.catchReason('RateLimiterError', 'RateLimitExceeded', () => Effect.logWarning(`Dropped ${job.template}: ${address} is over ${cap.limit} mails per ${Duration.format(Duration.fromInputUnsafe(cap.window))}`).pipe(Effect.as(false)))));
    });
    return EmailDelivery.of({
        send: Effect.fn('EmailDelivery.send')(function* (job) {
            const found = Arr.findFirst(loaded, ({ kind }) => kind.template === job.template);
            if (Option.isNone(found)) {
                return yield* new MailTemplateError({
                    template: job.template,
                    message: 'No mail kind declares this template',
                    cause: undefined,
                });
            }
            const recipients = yield* withinCap(job, found.value.kind.notice);
            if (!Arr.isReadonlyArrayNonEmpty(recipients))
                return;
            const { html, text } = yield* render(job.template, found.value.source, job.variables);
            yield* mailer.send(new MailMessage({ to: recipients, subject: job.options.subject, html, text }));
        }),
    });
});
/** Each declared kind with its MJML source, read from the directory or taken from the map. */
const loadSources = Effect.fnUntraced(function* (options) {
    const { templates } = options;
    if (typeof templates !== 'string') {
        const entries = yield* Effect.forEach(options.kinds, (kind) => Option.match(Record.get(templates, kind.template), {
            onNone: () => Effect.fail(new MailTemplateError({
                template: kind.template,
                message: 'The template map has no source for this kind',
                cause: undefined,
            })),
            onSome: (source) => Effect.succeed({ kind, source }),
        }));
        return entries;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* Effect.forEach(options.kinds, (kind) => fs.readFileString(path.join(templates, kind.template)).pipe(Effect.map((source) => ({ kind, source })), Effect.mapError((cause) => new MailTemplateError({
        template: kind.template,
        message: `Could not read the template from ${templates}`,
        cause,
    }))));
    return entries;
});
