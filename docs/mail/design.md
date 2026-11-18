# Mail: design

The `/mail` subpath (`@danielfgray/stompbox/mail`) sends email. It holds no
SQL and needs no auth feature. It replaces the `mailer.ts` and
`emailDelivery.ts` that effect-web-template, postgres.garden, setlist and
dfg.rocks each copy (`docs/research/account-mail-tasks.md`). The account tasks
that queue mail ship later with an `emails` SQL feature (ADR 0007).

Terms. A **job** is a row in the graphile-worker queue. A **mail kind** is one
sort of email: a template name and the variables that template reads. A
**template** is the app's MJML source for a kind. MJML is the markup language
that compiles to email HTML.

## Parts

| Part            | What it is                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `Mailer`        | Service with one method, `send(MailMessage)`. Adapters are static layers.                                |
| `MailCapture`   | Holds the messages the capture adapter took, for tests.                                                  |
| `EmailDelivery` | Service that renders a kind's template and sends it. Its `send` takes the payload of a `send_email` job. |
| `mailKind`      | Declares a kind: template name, variables as Schemas, and whether it is a notice.                        |
| `queuedEmail`   | The Schema of the `send_email` payload: any declared kind.                                               |

The `send_email` task belongs to the app's task list. It is an `effectTask`
from `/worker`:

```ts
send_email: effectTask(context)(queuedEmail(kinds), (job) => delivery.send(job))
```

## Mailer adapters

| Layer                                   | Use                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Mailer.layerSmtp(settings, from)`      | SMTP through nodemailer. The transport closes with the scope.                                                                                                                                          |
| `Mailer.layerCloudflare(from)`          | SMTP preset: host `smtp.mx.cloudflare.net`, user `api_token`, password `CLOUDFLARE_EMAIL_API_TOKEN`.                                                                                                   |
| `Mailer.layerEthereal({ from, file? })` | Development. Keeps its account in `ETHEREAL_ACCOUNT_FILE`, else `file`, else `.ethereal` in the working directory (not in `node_modules`).                                                             |
| `Mailer.layerCapture`                   | Tests. Requires `MailCapture`.                                                                                                                                                                         |
| `Mailer.layerConfig({ defaultFrom })`   | Picks one of the above from `MAIL_PROVIDER`; when unset, from `NODE_ENV` (production: cloudflare, test: capture, else ethereal). `EMAIL_FROM` overrides `defaultFrom`. It also provides `MailCapture`. |

There is no SES adapter: no app deploys it (ADR 0003). A rejected recipient or
an SMTP failure is a `MailDeliveryError`, which fails the job so that
graphile-worker retries it.

## Templates stay in the app

Each app keeps its own MJML, so each keeps its branding and layout. The
package ships no templates. It owns rendering:

1. Substitute `[[name]]` placeholders with lodash.template. The values are
   HTML-escaped. `projectName` and `legalText` come from `brand`.
2. Compile with `mjml` at `validationLevel: 'strict'`. Any error fails.
3. Make the text part with `html-to-text`.

Substitution happens before compilation, because a placeholder may sit in an
attribute (`href="[[verifyLink]]"`).

`EmailDelivery.layer({ kinds, templates, brand, cap? })` takes `templates` as
a directory of files named by `MailKind.template`, or a map from that name to
MJML source. When it builds, it loads every declared template and renders it
once with a sample for each declared variable. A template that is missing,
is not valid MJML, or reads a variable its kind does not declare fails the
layer with `MailTemplateError`. So a bad template stops the worker at start,
not at the first send. An app adds its own kinds the same way as any other:
declare them in `kinds`.

`mjml`, `nodemailer`, `html-to-text` and `lodash.template` are optional peer
dependencies of the package. The layer loads `mjml` with a dynamic import
when it builds; one process holds it for its life (the research's memory
note, B8, is accepted: loading at start costs about 20 MB and buys the
start-time check).

## Per-address cap

Mail to one address is capped at 5 per hour across all kinds, so that
requests from many networks cannot flood one inbox. The count is Effect's
`RateLimiter`, keyed `recipient:<lowercased address>`.

- A recipient over the cap is dropped with a warning and the job still
  succeeds: a failed job would be retried and the mail sent later anyway.
- A store that fails or does not answer in 1 second fails the job, so
  graphile-worker retries it.
- A kind declared `{ notice: true }` is exempt. Only an action on the account
  sends a notice, and a flood that used up the cap first would hide the
  notice of the attack.
- `cap: { limit, window }` changes the numbers. `cap: false` turns the cap
  off and then `EmailDelivery.layer` needs no `RateLimiter`.

Which store each app runs (read from each app's `server/runtime` and rate
limiter module; the worker's process was not traced in setlist and dfg.rocks):

| App                 | Server                       | Tests               |
| ------------------- | ---------------------------- | ------------------- |
| effect-web-template | Valkey (`RateLimiterValkey`) | memory              |
| postgres.garden     | Valkey                       | memory              |
| setlist             | Valkey                       | memory              |
| dfg.rocks           | Valkey                       | memory (not traced) |

Valkey keys start with `VALKEY_KEY_PREFIX` and `rl:`. A memory store counts
per process, so an app that runs the API and the worker as two processes with
a memory store applies the cap twice over; run the worker with Valkey.

## Invitation task factory

Every app that invites people to a group (a family, a band, an
organization) has the same job: load the invitation, build a link, send one
mail. The SQL that loads it differs per app, so `invitationTask` is a factory
that takes the differences:

```ts
const sendBandInvite = invitationTask({
	job: 'band_invitations__send_invite', // the name the SQL trigger queues
	group: 'band', // the template reads it as [[group]]
	acceptPath: '/invitations/accept',
	rootUrl: Config.String('VITE_ROOT_URL'),
	load: (id) => /* Effect<Option<LoadedInvitation>> over the app's tables */,
})
// in the app's task list:
[options.job]: sendBandInvite(context)
```

The result is an `effectTask` (`/worker`). It decodes `{ id }`, calls `load`,
and sends the declared kind `invitationMail` through `EmailDelivery`. The
app adds `invitationMail` to its `kinds` and ships one `invitation.mjml`
that reads `group`, `groupName`, `inviterName` (null when there is none) and
`link`. The subject is `You have been invited to <groupName>`.

`load` returns `Option<{ email, code, groupName, inviterName }>`:

- **None** (accepted or declined before the job ran): the job succeeds and
  sends nothing. Setlist and dfg.rocks do the same; a retry would find the
  same.
- **`email` none** (an invitation to an account that has no address): the
  job logs a warning and succeeds. Setlist logs an error and returns; dfg.rocks returns silently.

**Link.** `<rootUrl><acceptPath>?id=<id>#token=<code>`. The code travels in
the fragment, which no HTTP request carries, so it stays out of server logs
and `Referer`. The id is not secret and stays in the query. An app that now
links `?id=…&code=…` (setlist, dfg.rocks) must change its accept page to read
`code` from `#token=`.

**Account or new address.** Both copies already tell them apart by the row:
an invitation to a new address has an `email` and a `code`; one to an existing
account has a `user_id` and no `code`, and goes to that account's address.
The factory keeps this: no `code` means no fragment. Which address an account
gets is the app's loader: setlist takes the primary address, dfg.rocks takes
the primary, then the verified one (`is_primary desc, is_verified desc`).

**Stored code.** All four copies (the template, postgres.garden, setlist, dfg.rocks) store the invitation code in plaintext
(`code text`, 14 hex characters from `gen_random_bytes(7)` in the template),
because the accept function compares the code the reader sends with the
column. They do not differ, so there is no hashed copy to follow. The
template's account mail hashes tokens (B2), but its invitation code is plain.
So the loader reads the code from the row, and no app must change its SQL for
the factory. Hashing the invitation code is a separate change: the SQL would
mint the code, store its hash, and pass the plaintext in the job payload,
which the factory's `{ id }` payload does not carry.

**Template and postgres.garden.** They queue
`organization_invitations__send_invite` and have no task (research B1), so
their invitations are never mailed. Calling `invitationTask` for that job
name fixes it.
