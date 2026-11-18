import { Effect, Option, Schema } from 'effect';
import { effectTask } from '../worker/Job.js';
import { EmailDelivery, mailKind } from './EmailDelivery.js';
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
});
/** The payload the app's SQL trigger queues: the invitation's id. */
export const InvitationPayload = Schema.Struct({ id: Schema.String });
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
export const invitationTask = (options) => (context) => effectTask(context)(InvitationPayload, ({ id }) => options.load(id).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.logInfo(`Invitation ${id} not found: nothing to send`),
    onSome: (invitation) => Option.match(invitation.email, {
        onNone: () => Effect.logWarning(`Invitation ${id} has no address to send to: nothing to send`),
        onSome: (email) => send(options, id, email, invitation),
    }),
}))));
const send = Effect.fnUntraced(function* (options, id, email, invitation) {
    const rootUrl = (yield* options.rootUrl).replace(/\/+$/, '');
    const fragment = Option.match(invitation.code, {
        onNone: () => '',
        onSome: (code) => `#token=${encodeURIComponent(code)}`,
    });
    const delivery = yield* EmailDelivery;
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
    });
});
