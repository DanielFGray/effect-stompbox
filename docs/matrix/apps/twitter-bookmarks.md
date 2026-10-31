# twitter-bookmarks

App root: `~/build/twitter-bookmarks`. Paths below are relative to it. Commit
`1e39887` (2026-10-29).

**Users and auth:** none. The app is single-user. It has no users table, no
login and no session. The one owner is implied: the server reads that person's
Firefox cookie jar to call X and Reddit as them (`src/server/BrowserCookies.ts:14-32`).
The deployed container is reachable only on the tailnet (`cartridge.json:18`).

**Git history:** three commits. The first (`451d513`) imports the whole app;
the others rename `AGENTS.md` (`f834a5e`) and bump Effect packages to 4.1.0
(`1e39887`). `git log --follow` on `src/server/Db.ts`, `src/server/BookmarkStore.ts`
and `src/server/SyncJob.ts` shows only `451d513`, so there are no bug-fix
commits to cite.

## Rows

1. **Runtime and HTTP layer**: present. Bun runs the process
   (`package.json:7-8`, `Dockerfile:15`), but the server uses the Node platform
   package: `NodeRuntime.runMain(Layer.launch(AppLive))` (`src/server/Main.ts:4,7`)
   and `NodeHttpServer.layer(() => createServer(), { port })` from `node:http`
   (`src/server/Server.ts:9,13,45`). Routing is `HttpRouter.route` per
   endpoint, joined with `HttpRouter.addAll` (`src/server/Api.ts:29,228-240`),
   not `HttpApi`. `HttpRouter.serve` merges the API with
   `HttpStaticServer.layer({ root, spa: true })` for the built client
   (`src/server/Server.ts:29-32,44`). Boot runs `migrate` as a layer beside the
   server (`src/server/Server.ts:27,63`). The CLI `serve` command launches the
   same `AppLive` (`src/cli/main.ts:171`).

2. **Versions and data stack**: present. `effect` 4.1.0,
   `@effect/sql-sqlite-bun` 4.1.0, `@effect/platform-node` 4.1.0,
   `@effect/opentelemetry` 4.1.0 (`package.json:16-18,21`; installed versions
   confirmed in `node_modules`). SQL goes through `SqlClient` from `effect/sql`
   with tagged templates (`src/server/Db.ts:5`). No Kysely, no
   graphile-migrate, no graphile-worker.

3. **Config and env**: present. Effect `Config` reads every variable, each
   with a default except `HOME`: `DB_PATH` (`src/server/Db.ts:9`), `PORT` and
   `STATIC_ROOT` (`src/server/Server.ts:29-30,41-42`),
   `OTEL_EXPORTER_OTLP_ENDPOINT` (`src/server/Observability.ts:10-11`),
   `TYPESAFE_API_KEY` as optional `Config.Redacted`, `TYPESAFE_BASE_URL`,
   `TYPESAFE_DEFAULT_MODEL` (`src/server/TypeSafe.ts:56-62`), `X_QUERY_ID`,
   `X_BEARER`, `X_FEATURES` (`src/server/ScraperLive.ts:209-214`),
   `REDDIT_USERNAME` (`src/server/RedditLive.ts:188-189`), `HOME`
   (`src/server/BrowserCookies.ts:14`). Env file loading is Bun's automatic
   `.env` load (README "Environment" section); `.env.example` lists the
   variables (`.env.example:1-22`). No script generates `.env`. No variable is
   required to boot: a missing TypeSafe key fails only the classify stage
   (`src/server/TypeSafe.ts:53-56,67-68`).

4. **Pools and roles**: N/A (SQLite). SQLite equivalent: one
   `SqliteClient.layer({ filename })` built from `DB_PATH`
   (`src/server/Db.ts:11-17`), shared by the API, the sync job and the
   key/value store (`src/server/Server.ts:36,57`). No pragmas are set (no WAL,
   no `busy_timeout`); the only `pragma` use is `pragma_table_info` in
   migrations (`src/server/Db.ts:64,82,105,124`). `.gitignore` lists
   `bookmarks.db-wal` and `bookmarks.db-shm`, so WAL files have appeared at
   some time (`.gitignore:23-25`). A second, read-only `SqliteClient` is built
   per scrape over a temp copy of Firefox's `cookies.sqlite`
   (`src/server/BrowserCookies.ts:22-33`).

5. **Typed handles**: present, untyped by table. Services get `SqlClient`
   from context at construction: `BookmarkStore` (`src/server/BookmarkStore.ts:27`),
   scrapers (`src/server/ScraperLive.ts:190`), `SyncJob` captures it into a
   context for its forked fiber (`src/server/SyncJob.ts:110-112,225`). Types
   do not restrict which tables a handle reaches. Rows come back as `unknown`
   and decode through Schema classes (`src/server/DbSchema.ts:1-2,16-45`,
   `src/server/storeHelpers.ts:11-12`). Search builds dynamic SQL with
   `sql.unsafe` and positional `?` parameters (`src/server/BookmarkStore.ts:95-108`,
   `src/server/storeHelpers.ts:55-83`). No query uses a transaction: the
   multi-statement tag rename runs as separate statements
   (`src/server/BookmarkStore.ts:242-250`); `rg withTransaction` finds nothing.

6. **Database error mapping**: present, by error tag only. Each route catches
   its domain errors by tag and maps them to a status: `BadRequest` 400,
   `BookmarkNotFound` 404, `InvalidTag` 400, `TagExists` 409,
   `SyncAlreadyRunning` 409, `TranslateFailed` 502
   (`src/server/Api.ts:106-110,140-142,166-170,202-206`). Any other failure,
   including `SqlError`, becomes 500 with the first 120 characters of
   `String(cause)` in the body (`src/server/Api.ts:26-27,64,111`). SQLite
   error codes are not inspected; uniqueness is handled by
   `INSERT OR IGNORE` / `OR REPLACE` / `UPDATE OR IGNORE`
   (`src/server/BookmarkStore.ts:202,204,242`, `src/server/ScraperLive.ts:190`)
   and by a select-before-insert (`src/server/BookmarkStore.ts:71-75`).

7. **Migrations and codegen**: present (hand-written, idempotent), codegen
   absent. One `migrate` effect runs on every boot
   (`src/server/Db.ts:19-22,145`, `src/server/Server.ts:27`). It uses
   `CREATE TABLE IF NOT EXISTS`, then inspects `pragma_table_info` to add
   missing columns, drop retired ones, flatten an old label hierarchy, and
   rebuild the FTS table when it lacks `quoted_text`
   (`src/server/Db.ts:25-145`). There is no migration table, no version
   number and no file layout. No schemas (SQLite). The `sync_state` table is
   created by `KeyValueStore.layerSql`, outside `migrate`
   (`src/server/Server.ts:34-36`). Row types are hand-written Schema classes
   (`src/server/DbSchema.ts`); no codegen.
   SQLite tables:
   - `bookmarks`: integer id, platform, url, text, author, timestamp, plus
     enrichment columns (`src/server/Db.ts:25-45`); unique
     `(platform, url)` (`src/server/Db.ts:115`).
   - `labels`: `(bookmark_id, label)` key, `prob`, `confidence`, `source`
     (`src/server/Db.ts:47-54`).
   - `tags`: `spec` primary key, the tag vocabulary (`src/server/Db.ts:59-61`).
   - `bookmarks_fts`: FTS5 over text, author, quoted_text, kept in sync by
     insert and update triggers (`src/server/Db.ts:131-144`).
   - `sync_state`: key/value rows from `KeyValueStore.layerSql`
     (`src/server/Server.ts:36`).

8. **Sessions and cookies**: absent. The app sets no cookies and has no
   session. It only reads the owner's Firefox cookies to authenticate
   outbound calls to X and Reddit (`src/server/BrowserCookies.ts:10-40`).

9. **Password auth**: absent.

10. **OAuth**: absent. Outbound X and Reddit calls reuse browser session
    cookies instead (`src/server/BrowserCookies.ts:1`, README "Environment").

11. **Authorization**: absent. N/A for RLS. Every route is open
    (`src/server/Api.ts:228-240`). Data is not scoped per user; the whole
    database belongs to the one owner. Network reach is the only gate: the
    cartridge route is tailnet-only (`cartridge.json:18`).

12. **Rate limiting**: absent. No limiter on inbound routes. A semaphore
    allows one sync run at a time (`src/server/SyncJob.ts:103-105,213-219`).

13. **Realtime**: absent. The client polls `GET /api/sync` while a sync runs
    (`src/server/Api.ts:131-133,147-154`).

14. **Worker and mail**: present (in-process job), mail absent. `SyncJob`
    forks the pipeline (scrape X, scrape Reddit, classify) into the layer's
    scope with `Effect.forkIn` (`src/server/SyncJob.ts:106,123,225`). Its
    status is one JSON record under key `sync` in the key/value store
    (`src/server/SyncJob.ts:259-302`). A stage failure is recorded and the
    next stage still runs (`src/server/SyncJob.ts:64-80`). At boot a record
    left `running` is rewritten as interrupted (`src/server/SyncJob.ts:202-211`).
    No job queue, retries or scheduler. No mail.

15. **Test harness and test database**: present, narrow. `bun:test`
    (`src/server/SyncJob.test.ts:10`); no `test` script in `package.json`
    (`package.json:6-14`). The one server test builds
    `KeyValueStore.layerSql` over an in-memory SQLite to round-trip
    `SyncStatus` (`src/server/SyncJob.test.ts:16-21`). Other tests cover pure
    helpers (`src/shared/query.test.ts:4-81`, `src/client/*.test.ts`). No
    HTTP tests, no test database for the store, no fixtures, no auth to fake.

16. **Telemetry and logging**: present. `OtlpTracer.layer` over OTLP/HTTP
    JSON to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` with
    `serviceName: "bookmarks"` (`src/server/Observability.ts:10-20`). Spans
    via `Effect.withSpan` on migrate and store methods
    (`src/server/Db.ts:145`, `src/server/BookmarkStore.ts:139,182,217,225,252`).
    Logs use the default Effect logger (`src/server/SyncJob.ts:78,196`); no
    HTTP request logger middleware, no DevTools layer.

17. **API contract with the frontend**: present, one-sided. `src/shared/ApiSchema.ts`
    holds response Schemas the client decodes (`src/shared/ApiSchema.ts:1-3`,
    `src/client/api.ts:5-13,29-40`). The server does not import them: it
    builds JSON objects by hand in each route (`src/server/Api.ts:42-61`;
    `rg ApiSchema` finds only client imports). The query parser is shared by
    both sides (`src/server/storeHelpers.ts:7`, README "Layout"). No
    `HttpApi` client, no RPC.

18. **Deployment**: present. Two-stage `oven/bun:1` Dockerfile builds the
    client with Vite, then runs `bun src/server/Main.ts` with
    `DB_PATH=/data/bookmarks.db` (`Dockerfile:1-16`). `cartridge.json`
    (`apiVersion server-ansible/v2`) runs one service, mounts volume
    `twitter-bookmarks-data` at `/data`, health-checks `GET /api/sync`, and
    routes tailnet-only (`cartridge.json:2-19`). One process serves API and
    static client. The image holds no Firefox profile, and the scrapers read
    `$HOME/.mozilla/firefox` (`src/server/BrowserCookies.ts:14-17`).
    In development, Vite on 8004 proxies `/api` to 8003 (`vite.config.ts:6-10`).

19. **App-only backend features**:
    - X bookmark scraper replaying x.com's GraphQL endpoint (`src/server/ScraperLive.ts`, `src/server/XApi.ts`).
    - Reddit saved-items scraper (`src/server/RedditLive.ts`, `src/server/RedditApi.ts`).
    - Firefox cookie-jar reader (`src/server/BrowserCookies.ts`).
    - TypeSafe classifier client and per-tag yes/no labeling (`src/server/TypeSafe.ts`, `src/server/Classifier.ts`).
    - Google Translate client with result cached on the row (`src/server/Translator.ts`, `src/server/BookmarkStore.ts:254-267`).
    - FTS5 search with `#tag` / `-tag` query language (`src/shared/query.ts`, `src/server/storeHelpers.ts:55-83`).
    - Tag co-occurrence graph (`src/server/BookmarkStore.ts:182`).
    - CLI: scrape, enrich, classify, wordfreq, export, import, add, serve (`src/cli/main.ts:33-186`).
