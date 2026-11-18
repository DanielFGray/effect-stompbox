import { Cause, Context, Duration, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { RateLimiter, type RateLimiterError } from 'effect/persistence/RateLimiter';
import { type MailDeliveryError, Mailer } from './Mailer.ts';
/** What a template variable can hold: text, or a value that prints as text. */
export declare const MailValue: Schema.Union<readonly [Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]>;
export type MailValue = typeof MailValue.Type;
/** The payload of a `send_email` job, as `EmailDelivery.send` takes it. */
export declare const MailJob: Schema.Struct<{
    readonly options: Schema.Struct<{
        readonly to: Schema.Union<readonly [Schema.NonEmptyString, Schema.NonEmptyArray<Schema.NonEmptyString>]>;
        readonly subject: Schema.String;
    }>;
    readonly template: Schema.String;
    readonly variables: Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]>>;
}>;
export type MailJob = typeof MailJob.Type;
/**
 * One kind of mail: the template it renders and the variables that template
 * reads. `schema` decodes the job payload for that kind. A notice is exempt
 * from the per-address cap: only an action on the account sends one, and a
 * flood that used up the cap first would hide the notice of the attack.
 */
export interface MailKind {
    readonly template: string;
    readonly variables: ReadonlyArray<string>;
    readonly notice: boolean;
    readonly schema: Schema.Decoder<MailJob>;
}
/**
 * Declares a mail kind. `template` is the name the app's templates use (a file
 * name, or a key of the template map); `variables` are the fields of that
 * template's `[[placeholders]]`.
 */
export declare const mailKind: <const T extends string, const F extends {
    readonly [name: string]: Schema.Codec<MailValue, MailValue>;
}>(template: T, variables: F, options?: {
    readonly notice?: boolean;
}) => {
    template: T;
    variables: string[];
    notice: boolean;
    schema: Schema.Struct<{
        readonly options: Schema.Struct<{
            readonly to: Schema.Union<readonly [Schema.NonEmptyString, Schema.NonEmptyArray<Schema.NonEmptyString>]>;
            readonly subject: Schema.String;
        }>;
        readonly template: Schema.Literal<T>;
        readonly variables: Schema.Struct<F>;
    }>;
};
/** The schema of the `send_email` payload: any of `kinds`. */
export declare const queuedEmail: (kinds: ReadonlyArray<MailKind>) => Schema.Union<Schema.Decoder<{
    readonly options: {
        readonly to: string | readonly [string, ...string[]];
        readonly subject: string;
    };
    readonly template: string;
    readonly variables: {
        readonly [x: string]: string | number | boolean | null;
    };
}, never>[]>;
declare const MailTemplateError_base: Schema.Class<MailTemplateError, Schema.TaggedStruct<"MailTemplateError", {
    readonly template: Schema.String;
    readonly message: Schema.String;
    readonly cause: Schema.Defect;
}>, Cause.YieldableError & {
    readonly brand: unique symbol;
}>;
/** A template that is missing, does not compile, or does not render. */
export declare class MailTemplateError extends MailTemplateError_base {
}
export type EmailDeliveryOptions = {
    readonly kinds: ReadonlyArray<MailKind>;
    /** A directory of MJML files named by `MailKind.template`, or a map from that name to MJML source. */
    readonly templates: string | {
        readonly [template: string]: string;
    };
    /** Brand text every template can read as `[[projectName]]` and `[[legalText]]`. */
    readonly brand: {
        readonly projectName: string;
        readonly legalText: string;
    };
};
export type MailCap = {
    readonly limit?: number;
    readonly window?: Duration.Input;
};
declare const EmailDelivery_base: Context.ServiceClass<EmailDelivery, "@danielfgray/stompbox/mail/EmailDelivery", {
    readonly send: (job: MailJob) => Effect.Effect<void, MailTemplateError | MailDeliveryError | RateLimiterError | Cause.TimeoutError>;
}>;
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
export declare class EmailDelivery extends EmailDelivery_base {
    /** With the per-address cap: 5 mails per hour by default, counted in the app's `RateLimiter`. */
    static layer(options: EmailDeliveryOptions & {
        readonly cap?: MailCap;
    }): Layer.Layer<EmailDelivery, MailTemplateError, Mailer | RateLimiter | FileSystem.FileSystem | Path.Path>;
    /** With no cap, and no `RateLimiter` needed. */
    static layer(options: EmailDeliveryOptions & {
        readonly cap: false;
    }): Layer.Layer<EmailDelivery, MailTemplateError, Mailer | FileSystem.FileSystem | Path.Path>;
}
export {};
