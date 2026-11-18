# Account mail tasks: one design for four copies

Research for task ts-18411d. Nothing here is built. Every decision is a
proposal for the user.

Read on 2026-11-18, read-only, from these checkouts (abbreviations used in
citations):

| Short | Path                          | Mail code                                 |
| ----- | ----------------------------- | ----------------------------------------- |
| T     | `~/build/effect-web-template` | `worker/accountMail.ts`, `worker/email/*` |
| PG    | `~/build/postgres.garden`     | same layout as T                          |
| SL    | `~/build/setlist`             | `worker/email/*`, `worker/tasks/*.mjs`    |
| DFG   | `~/build/dfg.rocks`           | same layout as T, plus app services       |
| SB    | `~/build/stompbox`            | ADRs 0003, 0007, 0008, 0009, `docs/auth`  |

Terms. A **job** is a row that `graphile_worker.add_job` writes into the
queue. A **task** is the code that graphile-worker runs for one job name.
To **enqueue** is to write a job. The **payload** is the JSON a job carries.

## Summary

- The four copies are one design. Normalised for quotes and line breaks, PG
  differs from T by 36 changed lines in `mailer.ts`, 16 in `emailDelivery.ts`
  and 75 in `accountMail.ts`. The templates differ by 7 to 11 lines, all
  formatting. So the "230-500 lines" the task quotes is mostly formatting,
  plus import paths and app names.
- DFG and SL are older copies. They lack fixes that T and PG have (section
  1.2): plaintext tokens in the database, tokens in the URL query, no
  guard against a double send, and (DFG) no per-address mail cap.
- **A bug exists in T and PG today:** their SQL enqueues
  `organization_invitations__send_invite` and no task handles it, so the
  invitation mail is never sent (section 1.2, B1).
- The shared logic is the Mailer, the `send_email` delivery, the renderer and
  the six account tasks. The per-app data is names, URLs, link paths, group
  names, brand text and the SQL that loads an invitation.
- Proposal: a `/mail` subpath (Mailer, transports, `send_email`, templates
  compiled at package build time) that needs no SQL, and account tasks that
  ship **with** the SQL feature that enqueues them (ADR 0007). The invitation
  task is a factory: the app supplies the SQL that loads the invitation.

## 1. The jobs

### 1.1 One table per job

"Enqueued by" names the SQL line in the migration that is in force. For T the
migrations are `migrations/current/`. For the others the later committed files
replace earlier ones: PG's `000009.sql` replaces the token handling of
`000001.sql`.

**`send_email`**: render a template and send it. Consumer of every other job.

| App | Payload                                                                                                                                     | Enqueued by                                                                                                                                         | Handler                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| T   | `QueuedEmail`: `{ options: { to, subject }, template, variables }`, 5 templates (`T worker/email/emailDelivery.ts:13-56`)                   | Node code: `T worker/accountMail.ts:262-265`                                                                                                        | `T worker/email/emailDelivery.ts:111-146`  |
| PG  | same, 5 templates                                                                                                                           | Node code: `PG worker/accountMail.ts:243-247`                                                                                                       | `PG worker/email/emailDelivery.ts` (same)  |
| SL  | same plus `band_invite.mjml` (`SL worker/email/emailDelivery.ts:17-32`)                                                                     | Node code: `addJob('send_email', …)` in each task, e.g. `SL worker/tasks/user__forgot_password.mjs:46`                                              | `SL worker/email/emailDelivery.ts:76-96`   |
| DFG | same plus `magic_link`, `invitation`, `testimonial_reminder`, `contact_submission`, 9 templates (`DFG worker/email/emailDelivery.ts:18-75`) | Node code: `addJob` (`DFG server/db.ts:140-147`) from account mail, `server/services/families.ts:50`, `contact.ts:60`, `testimonialReminder.ts:181` | `DFG worker/email/emailDelivery.ts:99-131` |

**`user_emails__send_verification`**: mail the link that verifies an address.

| App | Payload         | Enqueued by (SQL)                                                                              | How the task differs                                                                                                                                                                                                                                   |
| --- | --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T   | `{ id, token }` | `T migrations/current/0130-user_emails.sql:187` (insert trigger, new address); `:325` (resend) | `T worker/accountMail.ts:135-194`. Checks the token's hash is the live one, skips if `verification_email_sent_at >= verification_token_generated`, queues the mail and records the send time in one transaction (`:183-193`).                          |
| PG  | `{ id, token }` | `PG migrations/committed/000009.sql:81`, `:171`                                                | Same as T.                                                                                                                                                                                                                                             |
| SL  | `{ id }`        | `SL migrations/committed/000001-release-1.sql:548` (trigger `tg__add_job`), `:1547` (resend)   | `SL worker/tasks/user_emails__send_verification.mjs:12-78`. Reads the plaintext `verification_token` column (`:24`). A 3-minute throttle runs in Node (`:47-53`). The job and the send-time update are two statements, not one transaction (`:71-77`). |
| DFG | `{ id }`        | `DFG migrations/committed/000001-initial-schema.sql:510` (trigger), `:1522` (resend)           | `DFG worker/accountMail.ts:97-125`. Reads plaintext `verification_token` (`:109`). No send guard at all: a retried job mails twice.                                                                                                                    |

**`user__forgot_password`**: mail the password-reset link.

| App | Payload                | Enqueued by (SQL)                                        | How the task differs                                                                                                                             |
| --- | ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T   | `{ id, email, token }` | `T migrations/current/0140-user_authentications.sql:326` | `T worker/accountMail.ts:84-99`. Skips a user that no longer exists. Link `/reset#token=…`. The database holds only `reset_password_token_hash`. |
| PG  | `{ id, email, token }` | `PG migrations/committed/000009.sql:245`                 | Same as T (`link("/reset", token)`, `PG worker/accountMail.ts:80`).                                                                              |
| SL  | `{ id, email, token }` | `SL migrations/committed/000001-release-1.sql:1000`      | `SL worker/tasks/user__forgot_password.mjs:11-47`. Link `/reset?userId=…&token=…` (`:41-43`). Plaintext `reset_password_token` column (`:416`).  |
| DFG | `{ id, email, token }` | `DFG migrations/committed/000001-initial-schema.sql:973` | `DFG worker/accountMail.ts:50-63`. Link `/reset-password?token=…`. Template variable is `resetLink`, not `verifyLink`.                           |

**`user__forgot_password_unregistered_email`**: tell an address with no
account that a reset was asked for.

| App | Payload     | Enqueued by (SQL)                                                                                                 | How the task differs                                                                         |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| T   | `{ email }` | `T migrations/current/0140-user_authentications.sql:288` (throttled to one per 15 minutes by the SQL, `:276-285`) | `T worker/accountMail.ts:101-112`. Variable `url` = root URL. Subject names the project.     |
| PG  | `{ email }` | `PG migrations/committed/000009.sql:210`                                                                          | Same as T.                                                                                   |
| SL  | `{ email }` | `SL migrations/committed/000001-release-1.sql:950`                                                                | `SL worker/tasks/user__forgot_password_unregistered_email.mjs:11-28`. Same as T.             |
| DFG | `{ email }` | `DFG migrations/committed/000001-initial-schema.sql:923`                                                          | `DFG worker/accountMail.ts:76-84`. Variable `email`, fixed subject "Password reset attempt". |

**`user__send_delete_account_email`**: mail the account-deletion link.

| App | Payload            | Enqueued by (SQL)                                         | How the task differs                                                                              |
| --- | ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| T   | `{ email, token }` | `T migrations/current/0140-user_authentications.sql:466`  | `T worker/accountMail.ts:114-126`. Link `/settings#token=…`. Hashed token in the database.        |
| PG  | `{ email, token }` | `PG migrations/committed/000009.sql:354`                  | Same as T (`PG worker/accountMail.ts:106`).                                                       |
| SL  | `{ email, token }` | `SL migrations/committed/000001-release-1.sql:1152`       | `SL worker/tasks/user__send_delete_account_email.mjs:10-30`. Link `/delete-account?token=…`.      |
| DFG | `{ email, token }` | `DFG migrations/committed/000001-initial-schema.sql:1126` | `DFG worker/accountMail.ts:85-96`. Link `/confirm-delete-account?token=…`, variable `deleteLink`. |

**`user__audit`**: tell the user about a security change, at every verified
address.

| App | Payload                                                                                                                          | Enqueued by (SQL)                                                                                                                                                                                                                                 | How the task differs                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T   | `{ type, user_id, extra1?, extra2? }`; the SQL also sends `extra3`, `current_user_id`, `schema`, `table`, which the task ignores | `tg__add_audit_job` (`T migrations/current/0030-common_triggers.sql:68`), used by triggers at `0130-user_emails.sql:45`, `:56` and `0140-user_authentications.sql:50`; direct calls at `0140:421` (reset), `:568` (change), `:767`, `:787` (link) | `T worker/accountMail.ts:46-82`. Subject prefix `[projectName]`. No mail for an event within 2 ms of the account's creation (`:60`). Fails with `NoVerifiedEmail` when no address is verified. |
| PG  | same                                                                                                                             | `PG migrations/committed/000001.sql:321`, `:332`, `:597`; `000009.sql:314`; `000008.sql:52`, `:70`                                                                                                                                                | Same as T.                                                                                                                                                                                     |
| SL  | same                                                                                                                             | `SL migrations/committed/000001-release-1.sql:513`, `:524`, `:766`; `000002-release-2.sql:287`, `:336`                                                                                                                                            | `SL worker/tasks/user__audit.mjs:47-146`. Same texts as T. Throws a bare `Error` when no address is verified (`:128-130`).                                                                     |
| DFG | same                                                                                                                             | `DFG migrations/committed/000001-initial-schema.sql:475`, `:486`, `:736`, `:1067`, `:1215`; `000005.sql:82`, `:103`; `000006.sql:151`                                                                                                             | `DFG worker/accountMail.ts:20-49`. Sends `userName`, `eventDescription` and `eventTime` to its own template; no subject prefix.                                                                |

**`<group>_invitations__send_invite`**: mail an invitation to join a group.
`group` is the app's word for it.

| App | Payload  | Enqueued by (SQL)                                                                                                | Handler                                                                                                                                                                                                                                                                      |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T   | `{ id }` | trigger `tg__add_job('organization_invitations__send_invite')`, `T migrations/current/0500-organizations.sql:96` | **None** (section 1.2, B1).                                                                                                                                                                                                                                                  |
| PG  | `{ id }` | `PG migrations/committed/000001.sql:1518`                                                                        | **None** (B1).                                                                                                                                                                                                                                                               |
| SL  | `{ id }` | `SL migrations/committed/000001-release-1.sql:1777` (`band_invitations`)                                         | `SL worker/tasks/band_invitations__send_invite.mjs:16-61`. Loads band name, code, and `coalesce(invitation.email, primary_email.email)` (`:24-33`). Link `/invitations/accept?id=…&code=…`. Subject names the band.                                                          |
| DFG | `{ id }` | `DFG migrations/committed/000001-initial-schema.sql:1791` (`family_invitations`)                                 | `DFG server/services/families.ts:21-53`, wired at `DFG worker/worker.ts:68`. Same shape; picks the address by `is_primary desc, is_verified desc` (`:35-41`), SL by `is_primary` only. Link `/accept-invite?id=…&code=…`. Fixed subject "You've been invited to DFG Portal". |

**`user__magic_link`**: DFG only. Payload `{ id, email, token }`, enqueued by
`DFG migrations/committed/000001-initial-schema.sql:2333` from
`app_private.generate_magic_link`, handler `DFG worker/accountMail.ts:64-75`.
The token is stored in plaintext (`magic_link_token`, `:2309`) with a
15-minute expiry (`:2331`). One app has it; it stays in that app (ADR 0008
needs three).

DFG also queues `send_email` for `testimonial_reminder` and
`contact_submission`. Those are product mail, not account mail, and stay in
DFG.

### 1.2 Real behaviour differences, bugs and fixes

Each row is a behaviour that exists in one copy and not in the others.
"Has it" means the code or SQL in force today.

| Id  | What                                                                                                                                                                            | Has the fix                                                           | Lacks it                                               | Evidence                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | The invitation job has a task. T and PG enqueue `organization_invitations__send_invite` and nothing handles it.                                                                 | SL, DFG                                                               | T, PG                                                  | The SQL lines in 1.1. `rg organization_invitations__send_invite` finds no task in T or PG code. graphile-worker 0.18.0 asks the database only for jobs of known tasks (`node_modules/graphile-worker/dist/sql/getJobs.js:28-30`), so the job is never fetched: no failure, no log, no mail. Read from the code, not run.  |
| B2  | Emailed tokens are stored as a SHA-256 hash; the plaintext rides only in the job payload.                                                                                       | T, PG                                                                 | SL, DFG                                                | `T migrations/current/0130-user_emails.sql:8-9`, PG commit `6c2a1fd`. SL stores `reset_password_token` and `delete_account_token` in plaintext (`SL migrations/committed/000001-release-1.sql:416-421`); DFG reads `verification_token` in Node (`DFG worker/accountMail.ts:109`).                                        |
| B3  | Links carry the token in the URL fragment (`#token=`), which no HTTP request sends, so it never reaches server logs or `Referer`.                                               | T, PG                                                                 | SL, DFG                                                | `T worker/accountMail.ts:273-275`, PG commit `6f93b99`. SL and DFG use `?token=` (`SL worker/tasks/user_emails__send_verification.mjs:64-66`, `DFG worker/accountMail.ts:60`, `:122`).                                                                                                                                    |
| B4  | A resend within 3 minutes keeps the mailed link alive: the SQL refuses to mint a new token inside the window.                                                                   | T, PG                                                                 | SL, DFG have no rotation, so they do not have this bug | T commit `3390361`; `T migrations/current/0130-user_emails.sql:300-312`. SL and DFG re-mail the stored token, so a resend never kills a link; SL throttles in Node, DFG does not throttle.                                                                                                                                |
| B5  | A retried verification job does not mail twice.                                                                                                                                 | T, PG (`already_sent`, `T worker/accountMail.ts:148-157`, `:172-176`) | SL (job and update are two statements), DFG (no guard) | `SL worker/tasks/user_emails__send_verification.mjs:71-77`; `DFG worker/accountMail.ts:97-125`.                                                                                                                                                                                                                           |
| B6  | Mail to one address is capped at 5 per hour, except security notices.                                                                                                           | T, PG, SL                                                             | DFG                                                    | `T worker/email/emailDelivery.ts:86-108`, `:162-169`; `SL worker/email/emailDelivery.ts:55-73`. DFG's `send` has no limiter (`DFG worker/email/emailDelivery.ts:99-131`).                                                                                                                                                 |
| B7  | A template that fails MJML validation fails the job.                                                                                                                            | T, PG, SL (`validationLevel: 'strict'` and errors thrown)             | DFG logs the errors and sends the mail anyway          | `T worker/email/emailDelivery.ts:123-128`; `DFG worker/email/emailDelivery.ts:114-119`.                                                                                                                                                                                                                                   |
| B8  | The renderer loads when the first mail is sent, not at boot. mjml and html-to-text held about 20 MB of resident memory (127 MB idle with them loaded at boot, 106 MB deferred). | PG (commit `15d2022`)                                                 | T, SL, DFG import `mjml` at the top                    | Commit message of `15d2022` (it moved the imports into a lazy `loadRenderers` in `worker/email/sendEmail.ts`); `T worker/email/emailDelivery.ts:5-7`. The current PG file imports both at the top again (`PG worker/email/emailDelivery.ts:5-7`), so the saving is gone in PG now. I did not trace which commit undid it. |
| B9  | The per-address cap key is `recipient:<address>` in T and PG, `email:<address>` in SL.                                                                                          | n/a                                                                   | n/a                                                    | `T worker/email/emailDelivery.ts:93`, `SL worker/email/emailDelivery.ts:61`. Only matters if two apps share one Valkey. Per-app data today.                                                                                                                                                                               |

Per-app data that is not a bug, found while comparing:

- **Brand text.** T, PG and DFG read `projectName` and `legalText` from
  `package.json` (`T worker/email/emailDelivery.ts:117-122`). SL imports
  `projectName` and builds `legalText` as `(C) <year> <projectName>`
  (`SL worker/email/emailDelivery.ts:84`).
- **From address.** `EMAIL_FROM`, with the default `fromEmail` from
  `package.json` (T, PG, DFG: `T worker/email/mailer.ts:193-195`) or a literal
  string (`SL worker/email/mailer.ts:77`).
- **Root URL.** T reads `VITE_ROOT_URL` when a link is built (`T
  worker/accountMail.ts:271`). PG trims trailing slashes (`PG
  server/config.ts:22-24`). SL reads `process.env.VITE_ROOT_URL` directly
  (`SL worker/tasks/user__forgot_password.mjs:41`). DFG uses `Config.NonEmptyString`
  (`DFG worker/accountMail.ts:173`).
- **Template variables.** T, PG and SL send the same variables to the same
  five templates. DFG renamed three (`resetLink`, `deleteLink`, `email`) and
  gave `account_activity` three variables instead of one
  (`DFG worker/email/emailDelivery.ts:24-52`). DFG's template files differ from
  T by 21 to 42 changed lines; PG's and SL's by 7 to 11, all formatting.
- **Where templates are found.** T and PG read `../templates/` relative to the
  module (`T worker/email/emailDelivery.ts:82-84`). DFG reads `WORKER_DIR`
  because production runs a bundle (`DFG worker/config.ts:3-6`). A package
  cannot know the app's template directory.

### 1.3 The worker lifecycle (for ts-fd548d, not for this design)

T and DFG start the runner inside the layer, so a runner that cannot start
stops the server (`T worker/worker.ts:61-128`, `DFG worker/worker.ts:116-166`).
PG and SL fork the start, so the server binds first and `isRunning` reports
failure (`PG worker/worker.ts:51-65`, `SL worker/worker.ts:21-28`). PG's
`isRunning` is inverted ("not stopped") so a runner that has not started yet
does not read as failed. All four use the same graphile options and the same
stop code. That decision belongs to ts-fd548d; it is noted here only because
the account tasks run inside that runner.

## 2. Shared logic and per-app data (ADR 0008)

ADR 0008: code with logic that three apps share ships in a package; the app
passes its own data in (`docs/adr/0008-shared-code-ships-as-packages.md:15-17`);
wiring stays with the app.

**Shared logic, carried by 3 or 4 apps.** Four apps carry: the Mailer, the
`send_email` delivery, the renderer, the verification, reset, deletion and
audit tasks (SL, T, PG, DFG all have them). Three apps carry: the invitation
task (T and PG enqueue it without a handler; SL and DFG have one). One app:
`user__magic_link`.

| Piece                                               | Shared?      | Notes                                                                                         |
| --------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `Mailer`, `MailMessage`, `MailDeliveryError`        | Shared       | Identical in T, PG, DFG; SL differs in transports only.                                       |
| SMTP transport, Ethereal, Cloudflare, capture       | Shared       | Cloudflare is SMTP with fixed host and `api_token` user (`T worker/email/mailer.ts:207-223`). |
| `mailProvider` config and its defaults              | Shared       | `MAIL_PROVIDER`, else production → cloudflare, test → capture, else ethereal (`:55-77`).      |
| `send_email` delivery, per-address cap, text render | Shared       | B6, B7.                                                                                       |
| Audit texts, `describe`                             | Shared       | Word for word in T, PG, SL, DFG (`T worker/accountMail.ts:277-304`).                          |
| `NoVerifiedEmail`, 2 ms account-creation rule       | Shared       |                                                                                               |
| Verify / reset / delete tasks                       | Shared logic | Differ only in data below.                                                                    |
| Default MJML templates (5)                          | Shared       | T, PG and SL are the same up to formatting.                                                   |
| Invitation task                                     | Shared shape | The SQL that loads it is app SQL: different tables, different columns.                        |

**Per-app data the app passes in.**

- From address and its development default.
- Root URL (`VITE_ROOT_URL`).
- Brand: `projectName`, `legalText`.
- Link paths: verify, reset, delete-account. Today: `/verify`, `/reset`,
  `/settings` (T, PG); `/verify-email`, `/reset-password`,
  `/confirm-delete-account` (DFG); `/verify-email`, `/reset`, `/delete-account`
  (SL).
- Subject prefix for audit mail (T, PG, SL use `[projectName]`; DFG none).
- Group label for invitations (`organization`, `family`, `band`), the job
  name, the accept path, and the function that loads an invitation.
- Template overrides (DFG's own wording and variable names).
- Rate-limit numbers (5 per hour today in all three apps that cap).

**Per-app code that stays in the app.** Product mail (`testimonial_reminder`,
`contact_submission`), `user__magic_link`, the task list, layer composition,
crontab, config.

## 3. Proposed API

Names are proposals. Subpath names follow ADR 0009 (one package, subpath per
concern).

### 3.1 `@danielfgray/stompbox/mail`: no SQL, no auth

```ts
// Service (ADR 0003: a service and its adapters)
class Mailer extends Context.Service<Mailer, {
  send: (message: MailMessage) => Effect<void, MailDeliveryError>
}>() {
  static layerSmtp(settings: SmtpSettings, from: string): Layer<Mailer>
  static layerCloudflare(from: string): Layer<Mailer>   // SMTP preset
  static layerEthereal(options?: { file?: string; from?: string }): Layer<Mailer>
  static layerCapture: Layer<Mailer, never, MailCapture>
  static layerConfig(options: { defaultFrom: string }): Layer<Mailer, ConfigError, …>
}
class MailCapture …           // the messages the capture adapter took, for tests
```

Transports, and who uses them today:

| Transport  | Used by                                                                                                                                                       | Proposal                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SMTP       | T, PG, DFG, SL (through Ethereal and Cloudflare)                                                                                                              | Ship. It is ADR 0003's default adapter (nodemailer).                                                                                                                                                                           |
| Cloudflare | All four set it in `cartridge.json` (PG `:43`, SL `:56`, DFG `:70-71`, T `:66-67`)                                                                            | Ship as an SMTP preset. It is settings, not a new adapter.                                                                                                                                                                     |
| Ethereal   | T, PG, DFG, SL development                                                                                                                                    | Ship as a preset. Its account file defaults to a path relative to the module (`T worker/email/mailer.ts:168`); in a package that would point into `node_modules`, so the default becomes `.ethereal` in the working directory. |
| Capture    | T, PG, DFG                                                                                                                                                    | Ship. SL has none (`SL worker/email/mailer.ts:32-45`: `test` mode needs a provider named).                                                                                                                                     |
| SES        | SL code only (`SL worker/email/mailer.ts:84-109`); SL deploys Cloudflare (`SL cartridge.json:56`) and documents SES as an option (`SL docs/deploy.md:96-103`) | **Do not ship.** ADR 0003 ships a second adapter only when an app uses it; none does in production.                                                                                                                            |

ADR 0003's table says "Other adapters an app already uses: none" for the mail
transport (`docs/adr/0003-opt-in-features-over-effect-services.md:39`).
That is true of deployments and false of code: SL carries SES. This design
keeps the table and drops SES from SL on adoption. User decision.

`layerConfig` keeps today's selection: `MAIL_PROVIDER` when set, else by
`NODE_ENV` (T `mailer.ts:55-77`). The app passes `defaultFrom`; `EMAIL_FROM`
overrides it.

```ts
// The send_email task
const QueuedEmail: Schema   // union of the default templates; apps extend it (3.3)
class EmailDelivery extends Context.Service<…>() {
  static layer(options: {
    brand: { projectName: string; legalText: string }
    templates?: TemplateOverrides
    cap?: { limit: number; window: Duration } | false   // default 5 per hour
  }): Layer<EmailDelivery, never, Mailer | RateLimiter>
}
```

`EmailDelivery` keeps the behaviour of T: cap by address with
`RateLimiter`, notices exempt, a store timeout fails the job so graphile
retries, strict validation. An app with no cap passes `cap: false` (DFG has
none today; B6 says it should adopt the cap).

### 3.2 How templates ship: compile at package build time

**Proposal: compile the default MJML to HTML when stompbox is built.** Ship
the HTML with the `[[variable]]` placeholders still in it. At run time only
`lodash.template` and `html-to-text` run. `mjml` becomes a stompbox
development dependency, and an optional peer of the app only if the app
overrides a template.

Evidence, from a probe run in the scratchpad (read-only use of T's
`node_modules`): `verify_email.mjml` compiled with `validationLevel: 'strict'`
before substitution gives 0 errors, and all four placeholders survive
(`verifyLink`, `token`, `projectName`, `legalText`). Substituting after
compile gives HTML byte-identical to the apps' order (substitute, then
compile): 12,973 characters in both. I tested one template, not all five.
Attributes such as `href="[[verifyLink]]"` are the case that could break, and
`verifyLink` is one, so the one test covers it; the other four are not tested.

Why build time:

- No `mjml` in the app's process: B8's 20 MB.
- No file read at run time, so no template directory to find (section 1.2,
  last bullet) and nothing for a bundler to miss.
- A malformed default template fails the package's build, not a job.

An app that wants other wording passes `templates: { verify_email: <MJML
source> }`. The package compiles an override on first use with a dynamic
`import('mjml')` (an optional peer), so an override costs the app its
`mjml` dependency and nothing else. DFG's own templates (`invitation`,
`testimonial_reminder`, `contact_submission`, `magic_link`) take this path.

### 3.3 Account tasks: what the app passes in

```ts
// Ships with the SQL feature `emails` (section 4)
class AccountMail extends Context.Service<…>() {
  static layer(options: {
    rootUrl: Config<string>                  // VITE_ROOT_URL, trailing slashes trimmed
    paths?: { verify?: string; reset?: string; deleteAccount?: string }
    subjectPrefix?: string                   // default `[${projectName}]`; '' to omit
    projectName: string
  }): Layer<AccountMail, never, SqlClient>
}

// One call gives the graphile task record for the six jobs
accountMailTasks(context): {
  send_email, user__audit, user__forgot_password,
  user__forgot_password_unregistered_email,
  user__send_delete_account_email, user_emails__send_verification,
}
```

`accountMailTasks` calls `effectTask` from `/worker` (ts-fd548d): each task
is a Schema and a handler, which is the shape T already uses (`T
worker/worker.ts:70-81`). The app spreads the record into its own task list
and may replace any entry. That is the escape hatch; there is no hook system.

Link paths default to the fragment form (`/verify#token=…`, B3). An app that
keeps `?token=` links must change its front end to read the fragment. That
cost falls on SL and DFG, and is the point of B3.

**Invitations are a factory, not a fixed task**, because the SQL that loads
an invitation is the app's:

```ts
invitationTask({
	job: 'band_invitations__send_invite', // the name the app's trigger enqueues
	group: 'band', // used in the template text
	acceptPath: '/invitations/accept',
	load: (id: string) =>
		Effect<
			Option<{ email: string; code: string | null; groupName: string }>,
			SqlError,
			SqlClient
		>,
})
```

The package builds the link (`?id=…&code=…`), the subject and the `send_email`
job. The app owns `load`, which is the join over its own tables (SL
`band_invitations__send_invite.mjs:24-33`, DFG `families.ts:25-48`). One
`invitation` template replaces `band_invite.mjml` and `invitation.mjml`.

If the app does not call `invitationTask` for a job its SQL enqueues, nothing
tells it (B1). The proposal does not solve that. A check that every
`add_job('<name>'` in the app's SQL has a task in the task list belongs in
the checker (`src/checker`); it would have caught B1 in T and PG. Open
question 3.

## 4. What belongs to the auth features (ADR 0007), what stands alone

ADR 0007: a feature is a directory of numbered migrations, and the SQL API
only grows (`docs/adr/0007-features-delivered-as-versioned-sql.md:8-16`). The
SQL that enqueues a job ships with the feature that owns the event. So a task
whose job comes from feature SQL ships with that feature, and the payload
schema is part of the feature's API: it can gain fields, not lose or rename
them.

Today SB ships two features, `auth` (identity and sessions: `src/auth/migrations/0001-sessions.sql`) and
`passwords` (`src/auth/passwords/0001-passwords.sql`). Neither has an email
table or an `add_job` call (`rg add_job src` finds none). SB's design keeps
identity in `auth.users` and leaves profiles to the app
(`docs/auth/design.md:45-48`). So the address table, its token secrets and the
mail SQL do not exist in SB yet.

| Job                                             | Belongs to                                                                                                            | Why                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_emails__send_verification`                | New feature `emails` (addresses, verification token, resend window)                                                   | Enqueued by the insert trigger and `resend_email_verification_code` (T `0130:187`, `:325`). The handler reads those tables.                                |
| `user__forgot_password`, `…_unregistered_email` | `emails` + `passwords`: the reset needs an address to mail and a password to set                                      | Enqueued by `forgot_password` (T `0140:288`, `:326`). Needs `emails`, so the feature depends on it.                                                        |
| `user__send_delete_account_email`               | `emails` (account deletion)                                                                                           | Enqueued by `request_account_deletion` (T `0140:466`). Could be its own small feature; no app wants it without `emails`.                                   |
| `user__audit`                                   | `emails` for `tg__add_audit_job` and the address triggers; each other feature (passwords, OAuth) adds its own trigger | The task is generic over event type; each feature's SQL enqueues its own events. One schema union, grown by each feature.                                  |
| `send_email`                                    | **Stands alone** (`/mail`)                                                                                            | No SQL enqueues it. Any app code can queue it.                                                                                                             |
| `<group>_invitations__send_invite`              | **Stands alone** (`/mail`, factory)                                                                                   | The trigger is on the app's group table. Groups are "below three, decision for you" (`docs/matrix/README.md`, row 11). The factory takes the app's loader. |
| `user__magic_link`                              | App                                                                                                                   | One app (DFG).                                                                                                                                             |
| Product mail                                    | App                                                                                                                   |                                                                                                                                                            |

**Fit with ts-a079a9.** That task is a draft titled "Auth: email
verification and OAuth features", matrix rows 9-10 and 14. This design says
`emails` is a feature with three parts:

1. SQL: `auth.user_emails`, `auth_private.user_email_secrets` (token hash,
   generated-at, sent-at), the insert trigger, `resend` with the 3-minute
   window (B4), `verify_email`, `forgot_password`, the audit trigger. Source
   to port: T `0130-user_emails.sql` and `0140-user_authentications.sql`, the
   copies that have B2 and B4 fixed. The matrix rule 6 (every emailed token
   has a checked expiry, `docs/matrix/README.md:123`) applies to its tokens.
2. The tasks of section 3.3 for its jobs.
3. Tests: T and PG already test each task from the SQL that enqueues it
   (`T worker/accountMail.test.ts`, `PG worker/accountMail.test.ts:1-30`:
   "each test starts from the SQL that queues a job, runs the job on the
   payload that SQL queued"). That is the right test; the package keeps it.

ts-a079a9's description is one line. I propose it be split in two: `emails`
with its tasks, and OAuth separately. The `/mail` subpath has no dependency on
either and can ship first.

One consequence, flagged as a decision for the user: the account tasks need a
storage reader, and ADR 0003 says a feature whose logic is SQL has no storage
adapter ("the database is the service", `:46-50`). So the tasks ship only with
the feature SQL; an app on its own `app_public.user_emails` cannot use them
without moving to `auth.*`. I rejected a `Lookups` service that would let an
app keep its tables: it is a second path next to the feature SQL, and ADR 0007
rejected "copy the SQL into each app" for the same reason.

## 5. Adoption order, and what each app deletes

Order, with the reason:

1. **Prerequisite: `/worker` (ts-fd548d).** `effectTask`, `runWorker`.
2. **`/mail` without SQL.** Mailer, transports, `EmailDelivery`, default
   templates. No schema change, no behaviour change in T, PG, SL.
   - **T first.** It is the reference for step 4 of the plan and the source
     of the port.
   - **PG second.** Its mail files are T's up to formatting; the swap is a
     deletion.
   - **SL third.** Needs `EMAIL_FROM` in place of its literal default, drops
     SES, gains capture. Its `tasks/*.mjs` stay until step 4.
   - **DFG last.** Behaviour changes: it gains the cap (B6) and strict MJML
     (B7), and its five account templates either follow T's variables or move
     to overrides.
3. **Invitation factory.** After step 2, per app, because it needs only the
   app's `load`. This fixes B1 in T and PG at once (they also need a
   `load` over `organization_invitations`).
4. **Feature `emails` and the account tasks (ts-a079a9, then ts-ca00b9).**
   Order T, PG, SL, DFG. Each app first adopts `auth` and `passwords`
   (ts-da32f5 covers adoption of other subpaths), since `emails` depends on
   them. SL and DFG take B2, B3 and B5 here, and must update their front-end
   routes to read `#token=`.

What each app deletes (line counts from `wc -l`; the test files move to the
package):

| App | After step 2                                                                                                                                                 | After step 4                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T   | `worker/email/mailer.ts` (257), `worker/email/emailDelivery.ts` (169), 5 templates (466), its two email tests (285 + 285 lines minus what the package keeps) | `worker/accountMail.ts` (304), the account SQL files `0130-user_emails.sql` and the mail parts of `0140`, `accountMail.test.ts` (285)                                                                                                                                    |
| PG  | `mailer.ts` (249), `emailDelivery.ts` (167), 5 templates (441), their tests (260)                                                                            | `accountMail.ts` (284), `accountMail.test.ts` (266), the mail SQL in `000001`/`000009`                                                                                                                                                                                   |
| SL  | `mailer.ts` (151), `emailDelivery.ts` (118), 6 templates (531), `job.ts` (73, replaced by `/worker`)                                                         | `tasks/user__audit.mjs` (146), `user__forgot_password.mjs` (47), `…unregistered_email.mjs` (28), `user__send_delete_account_email.mjs` (30), `user_emails__send_verification.mjs` (78), `band_invitations__send_invite.mjs` (61, replaced by a `load` of about 10 lines) |
| DFG | `mailer.ts` (246), `emailDelivery.ts` (137), the 5 account templates (454); keeps 4 product and magic-link templates                                         | `accountMail.ts` (202, minus `magicLink`, which stays); `families.sendInvitation` becomes a `load`                                                                                                                                                                       |

Each app keeps: its task list, crontab, layer composition, product mail,
`EMAIL_FROM` and root URL in its cartridge, and the SQL for groups.

## 6. Open questions for the user

1. **SES in SL.** Drop it on adoption (proposed, matches ADR 0003)? Or ship a
   second adapter because SL's code has one?
2. **Fragment links for SL and DFG.** The package's links use `#token=`. SL
   and DFG then change their front-end routes. Accept, or give the package a
   per-app token placement (a flag, which I advise against)?
3. **A checker rule for "every enqueued job name has a task".** It would have
   caught B1. In scope for `src/checker`?
4. **Is B1 live?** T is a template, and PG's `organizations` schema has no
   code that uses it (`docs/matrix/README.md`, row 11). The invitation jobs
   may never be enqueued in production. I did not check PG's production
   database.
5. **Split of ts-a079a9** into `emails` and OAuth (section 4).
6. **Per-address cap with no Valkey.** `EmailDelivery` requires a
   `RateLimiter`. DFG runs the memory store today (`docs/matrix/README.md`,
   row 12), which is per process; with the API and the worker as two
   processes (row 18) a memory store does not see both. Not checked per app.

## What I did not check

- No code ran, except the one MJML probe in section 3.2.
- Production databases, and whether any job row is stuck, were not read.
- SL's `current/1-current.sql` and DFG's `current/*.sql` were not read for
  mail SQL; the `add_job` search covered all of each `migrations/` tree and
  found enqueues only in the committed files listed.
- Token expiry checks (matrix rule 6) were read in T only.
- The `/worker` source in SB is being written by another agent; I read its
  export names only (`src/worker/index.ts`).
