import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';
declare const MailMessage_base: Schema.Class<MailMessage, Schema.Struct<{
    readonly to: Schema.NonEmptyArray<Schema.NonEmptyString>;
    readonly subject: Schema.String;
    readonly html: Schema.String;
    readonly text: Schema.String;
}>, {
    readonly brand: unique symbol;
}>;
export declare class MailMessage extends MailMessage_base {
}
declare const MailDeliveryError_base: Schema.Class<MailDeliveryError, Schema.TaggedStruct<"MailDeliveryError", {
    readonly message: Schema.String;
    readonly cause: Schema.Defect;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
export declare class MailDeliveryError extends MailDeliveryError_base {
}
declare const SmtpSettings_base: Schema.Class<SmtpSettings, Schema.Struct<{
    readonly host: Schema.String;
    readonly port: Schema.Int;
    readonly secure: Schema.Boolean;
    readonly credentials: Schema.Option<Schema.Struct<{
        readonly user: Schema.String;
        readonly pass: Schema.Redacted<Schema.String>;
    }>>;
}>, {
    readonly brand: unique symbol;
}>;
export declare class SmtpSettings extends SmtpSettings_base {
}
export declare const MailProvider: Schema.Literals<readonly ["ethereal", "capture", "cloudflare"]>;
export type MailProvider = typeof MailProvider.Type;
/**
 * `MAIL_PROVIDER` when set; otherwise production → cloudflare, test → capture,
 * everything else → ethereal.
 */
export declare const mailProvider: Config.Config<MailProvider>;
declare const MailCapture_base: Context.ServiceClass<MailCapture, "@danielfgray/stompbox/mail/MailCapture", {
    readonly record: (message: MailMessage) => Effect.Effect<void, never, never>;
    readonly sent: Effect.Effect<readonly MailMessage[], never, never>;
}> & {
    readonly make: Effect.Effect<{
        readonly record: (message: MailMessage) => Effect.Effect<void, never, never>;
        readonly sent: Effect.Effect<readonly MailMessage[], never, never>;
    }, never, never>;
};
/**
 * The messages the capture adapter took, oldest first, for tests and testing
 * routes to read. It stays empty under every other adapter.
 */
export declare class MailCapture extends MailCapture_base {
    static readonly layer: Layer.Layer<MailCapture, never, never>;
}
declare const Mailer_base: Context.ServiceClass<Mailer, "@danielfgray/stompbox/mail/Mailer", {
    readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryError>;
}>;
/**
 * Delivers mail. It has no `make`: an app picks an adapter, and no adapter is
 * the default. `layerConfig` picks one from `MAIL_PROVIDER` or `NODE_ENV`.
 */
export declare class Mailer extends Mailer_base {
    /** SMTP to `settings`, with `from` as the sender. The transport closes with the scope. */
    static readonly layerSmtp: (settings: SmtpSettings, from: string) => Layer.Layer<Mailer, MailDeliveryError, never>;
    /** Cloudflare Email Service: SMTP with the user `api_token` and `CLOUDFLARE_EMAIL_API_TOKEN`. */
    static readonly layerCloudflare: (from: string) => Layer.Layer<Mailer, Config.ConfigError | MailDeliveryError, never>;
    /**
     * Ethereal's SMTP, for development, with an account kept in `file`
     * (`ETHEREAL_ACCOUNT_FILE`, else `.ethereal` in the working directory). The
     * first run creates the account and writes the file.
     */
    static readonly layerEthereal: (options: {
        readonly from: string;
        readonly file?: string;
    }) => Layer.Layer<Mailer, Config.ConfigError | MailDeliveryError | import("effect/PlatformError").PlatformError | Schema.SchemaError, FileSystem.FileSystem | Path.Path>;
    /** Sends nothing: each message is kept in `MailCapture`. */
    static readonly layerCapture: Layer.Layer<Mailer, never, MailCapture>;
    /**
     * The adapter `mailProvider` selects. `EMAIL_FROM` overrides `defaultFrom`.
     * It also provides the `MailCapture` that `layerCapture` writes.
     */
    static readonly layerConfig: (options: {
        readonly defaultFrom: string;
    }) => Layer.Layer<MailCapture | Mailer, Config.ConfigError | MailDeliveryError | import("effect/PlatformError").PlatformError | Schema.SchemaError, FileSystem.FileSystem | Path.Path>;
}
export {};
