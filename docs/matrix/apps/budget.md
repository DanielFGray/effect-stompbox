# budget

App root: `~/build/budget`. Paths below are relative to it. Citations are to the working tree on top of commit `58f2c38`; it has uncommitted changes in 16 files. In `server/` only the port line differs: the commit hard-codes `SERVER_PORT = 3002`, the working tree reads `BUDGET_API_PORT` or `PORT` (default 3003). `AGENTS.md` is untracked.

**Users and auth:** none. The app is single-user. It has no users table, no
login and no session. `AGENTS.md:3` says the app holds the owner's real
financial data.

**Git history:** four commits. None is a bug fix. Commits that touched the
backend files:
- `4f29b1d`: first version of `server/`.
- `44ec5eb`: added the `categories` table and endpoints; removed the
  seed-on-empty inserts from the migration layer.
- `b5b955d`: wrapped every SQL call in `Effect.orDie`, so `SqlError` became a
  defect instead of a typed failure; wrapped `Layer.launch` in `Effect.orDie`.
- `58f2c38`: added `HOST` binding and formatting changes.

## Rows

1. **Runtime and HTTP layer**: present. Bun (`package.json:9`,
   `bun --hot server/index.ts`). Platform package `@effect/platform-bun`:
   `BunHttpServer.layer({ port, hostname })` and `BunRuntime.runMain`
   (`server/index.ts:3,66,69-73`). Router is `HttpApi`: three
   `HttpApiGroup`s joined in `BudgetApi` (`server/api.ts:16-61`), served by
   `HttpApiBuilder.serve(HttpMiddleware.logger)` with
   `HttpApiBuilder.middlewareCors()` (`server/index.ts:63-67`). The frontend
   is a separate process: `fibrae serve` on port 4010 (`package.json:13`).

2. **Versions and data stack**: present. `effect` ^3.21.1 (3.21.1
   installed), `@effect/platform` 0.96, `@effect/platform-bun` 0.89,
   `@effect/sql` 0.51, `@effect/sql-sqlite-bun` 0.52, `fibrae` 0.3.2,
   `@effect-atom/atom` 0.5.3 (`package.json:16-28`). `overrides` pin the
   Effect packages to one version set (`package.json:34-44`). No Kysely, no
   graphile-migrate, no graphile-worker.

3. **Config and env**: present, minimal. `process.env` read directly, not
   Effect `Config`: `BUDGET_API_PORT` or `PORT` (default 3003) and `HOST`
   (default `127.0.0.1`) (`server/index.ts:10-12`). The client reads
   `BUDGET_API_ORIGIN` / `VITE_BUDGET_API_ORIGIN` and `BUDGET_API_PORT` /
   `VITE_BUDGET_API_PORT` (`src/app/data.ts:14-30`); Vite reads `HOST` and
   `BUDGET_API_PORT` (`vite.config.ts:5-6`). No `.env` file, no `.env.example`,
   no generator script. No required variables.

4. **Pools and roles**: N/A (SQLite). SQLite equivalent: one
   `SqliteClient.layer({ filename: "budget.db" })`, a path relative to the
   working directory (`server/index.ts:16-18`). No pragmas set. The same
   layer value is provided to migrations and to the API
   (`server/index.ts:49,58`).

5. **Typed handles**: present, untyped by table. Each handler group takes
   `SqlClient.SqlClient` from context (`server/handlers.ts:13,45,102`) and
   runs tagged-template SQL with a type argument such as
   `sql<CategoryItem>` (`server/handlers.ts:17`). The type argument is an
   unchecked cast; rows are not decoded through Schema. Return values are
   built by hand and cast with `as` (`server/handlers.ts:25,64,83`). No
   transactions: update and delete do select-then-write as two statements
   (`server/handlers.ts:69-83,145-153`).

6. **Database error mapping**: present, one error. `ItemNotFoundError` is
   declared on update and remove endpoints with status 404
   (`server/api.ts:22,33,38,49,54`; `server/schemas.ts:64-67`). The handler
   raises it after a `SELECT` finds no row (`server/handlers.ts:34-36,73-75`).
   Every SQL call is wrapped in `Effect.orDie` (`server/handlers.ts:17,23,37`
   and the rest), so any `SqlError` is a defect and `HttpApi` returns 500.
   SQLite error codes are not inspected.

7. **Migrations and codegen**: present (inline), codegen absent.
   `MigrationsLive` is a `Layer.effectDiscard` that runs three
   `CREATE TABLE IF NOT EXISTS` statements on every boot
   (`server/index.ts:20-49`). No migration table, no versioning, no
   `ALTER` path. No codegen; row types are the API Schema classes
   (`server/schemas.ts`).
   SQLite tables:
   - `categories (id TEXT PK, name, color)` (`server/index.ts:25-29`).
   - `income (id TEXT PK, name, amount REAL, frequency)` (`server/index.ts:32-37`).
   - `expenses (id TEXT PK, name, amount REAL, frequency, category TEXT)`
     (`server/index.ts:40-46`). `category` has no foreign key to
     `categories`.

8. **Sessions and cookies**: absent.

9. **Password auth**: absent.

10. **OAuth**: absent.

11. **Authorization**: absent. N/A for RLS. All endpoints are open
    (`server/api.ts:58-61`). Data is not scoped per user; the whole file
    belongs to the one owner. CORS uses `middlewareCors()` with default
    options (`server/index.ts:65`). The server binds `127.0.0.1` unless
    `HOST` is set (`server/index.ts:11`).

12. **Rate limiting**: absent.

13. **Realtime**: absent.

14. **Worker and mail**: absent.

15. **Test harness and test database**: absent. No test files and no test
    script (`package.json:6-14`). `AGENTS.md:3` tells agents to test against
    the running app with reads, and to revert any write.

16. **Telemetry and logging**: present, minimal. `HttpMiddleware.logger`
    logs each request (`server/index.ts:63`). One `console.log` of the URL
    at start (`server/index.ts:75`). No OTLP, no spans, no DevTools.

17. **API contract with the frontend**: present. The client imports
    `BudgetApi` and the Schema classes from `server/` and builds a typed
    client with `AtomHttpApi.Tag` over `FetchHttpClient`
    (`src/app/data.ts:2,5-6,58-62`). In the browser and during server
    rendering it prefixes requests with an API origin chosen from env and
    `window.location` (`src/app/data.ts:32-56`). In development Vite proxies
    `/api` to the API port (`vite.config.ts:50-52`).

18. **Deployment**: absent. No Dockerfile, no `cartridge.json`, no ops
    files. Process layout: `dev` runs the Vite client and the Bun API
    together with `run-p` (`package.json:7-9`). `start` builds and runs
    `fibrae serve` only; it does not start the API (`package.json:12-13`).

19. **App-only backend features**:
    - CRUD for income, expenses and categories (`server/handlers.ts`).
    - Frequency enum (weekly, biweekly, monthly, yearly) (`server/schemas.ts:5`); monthly conversion is client-side (`src/app/data.ts:73-80`).

## Observations

- IDs come from a module-level counter, `item-${++nextId}`, that restarts at
  0 on each process start (`server/handlers.ts:8-9`). After a restart, a
  create can produce an id already in the table; the `INSERT` then fails on
  the primary key and `Effect.orDie` turns it into a 500
  (`server/handlers.ts:21-23`). A read-only count of the live `budget.db`
  shows both `item-*` ids and other id formats in each table (for example
  6 of 12 expense ids match `item-%`), so earlier code or manual edits also
  wrote rows. This is a reading of the code; it was not reproduced.
