import { Effect, Result, Schema } from 'effect';
import * as Digest from 'effect/crypto/Digest';
import { SqlClient } from 'effect/sql/SqlClient';
import { Finding, RoleContract, roleContract } from '../checker/index.js';
import { DeliveryRefused } from './DeliveryRefused.js';
import { dependencyOrder, readMigrations, } from './Feature.js';
import { prepareSql } from './Splitter.js';
/**
 * Installs or upgrades `features` on the connected database, which must be
 * the owner pool (the migration login, ADR 0002). Every check runs first:
 * the dependency order, each file's SQL, the connection's role, and that no
 * migration that already ran has changed. Then every pending migration of
 * every feature runs in one transaction, under one advisory lock, each
 * feature to its latest version in dependency order. A failure leaves every
 * feature at its old version.
 */
export const deliver = Effect.fn('deliver')(function* (features) {
    const sql = yield* SqlClient;
    const ordered = yield* dependencyOrder(features);
    const roles = yield* roleContract;
    const bootstrap = yield* prepare(roles, {
        feature: 'stompbox',
        number: 0,
        name: 'bootstrap',
        text: bootstrapSql,
    });
    const files = yield* Effect.forEach(ordered, (feature) => readMigrations(feature).pipe(Effect.flatMap(Effect.forEach((file) => prepare(roles, file)))));
    return yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql `select pg_advisory_xact_lock(${lockKey})`;
        const [{ name }] = yield* sql `select current_user as name`.pipe(Effect.flatMap(decodeOne(Schema.Struct({ name: Schema.String }))));
        if (name !== roles.owner)
            return yield* new DeliveryRefused({
                reason: `migrations run as the owner role ${roles.owner}, not as ${name}`,
            });
        yield* Effect.forEach(bootstrap.statements, (s) => sql.unsafe(s), { discard: true });
        const recorded = yield* sql `select feature, number, sha256 from stompbox.migrations`;
        yield* refuseChanged(recorded, files.flat());
        return yield* Effect.forEach(files, (featureFiles, i) => {
            const feature = ordered[i]?.name ?? '';
            const from = Math.max(0, ...recorded.filter((r) => r.feature === feature).map((r) => r.number));
            const pending = featureFiles.filter((f) => f.number > from);
            return Effect.forEach(pending, (file) => Effect.forEach(file.statements, (s) => sql.unsafe(s), { discard: true }).pipe(Effect.andThen(sql `insert into stompbox.migrations (feature, number, name, sha256)
							                   values (${file.feature}, ${file.number}, ${file.name}, ${file.sha256})`), Effect.withSpan('deliver.migration', {
                attributes: { feature, number: file.number },
            })), { discard: true }).pipe(Effect.as({
                feature,
                from,
                to: Math.max(from, featureFiles.length),
            }));
        });
    }));
});
/**
 * Finds each feature whose version in the database is behind its latest
 * migration, as startup findings. Runs as the visitor, through
 * `stompbox.feature_versions()`. A database ahead of the code passes,
 * because the old code runs against the migrated database during a deploy.
 */
export const versionsBehind = Effect.fn('versionsBehind')(function* (features) {
    if (features.length === 0)
        return [];
    const sql = yield* SqlClient;
    const latest = yield* Effect.forEach(features, (feature) => Effect.map(readMigrations(feature), (files) => ({
        feature: feature.name,
        version: files.length,
    })));
    const [{ installed }] = yield* sql `
    select to_regprocedure('stompbox.feature_versions()') is not null as installed`.pipe(Effect.flatMap(decodeOne(Schema.Struct({ installed: Schema.Boolean }))));
    const versions = installed
        ? yield* sql `select feature, version from stompbox.feature_versions()`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FeatureVersion))))
        : [];
    return latest.flatMap(({ feature, version }) => {
        const found = versions.find((v) => v.feature === feature)?.version ?? 0;
        return found >= version
            ? []
            : [
                new Finding({
                    level: 'error',
                    check: 'feature_version',
                    object: `feature ${feature}`,
                    problem: `the database has version ${found}, the code needs ${version}`,
                    rule: 'Run the migrations before the code that needs them starts.',
                }),
            ];
    });
});
const decodeOne = (row) => Schema.decodeUnknownEffect(Schema.Tuple([row]));
const FeatureVersion = Schema.Struct({ feature: Schema.String, version: Schema.Int });
const Recorded = Schema.Struct({
    feature: Schema.String,
    number: Schema.Int,
    sha256: Schema.String,
});
const prepare = Effect.fnUntraced(function* (roles, file) {
    const prepared = yield* Result.match(prepareSql(file.text, placeholders(roles)), {
        onSuccess: Effect.succeed,
        onFailure: (refused) => Effect.fail(new DeliveryRefused({
            reason: `${file.feature}/${String(file.number).padStart(4, '0')}-${file.name}.sql:${refused.line}: ${refused.reason}`,
        })),
    });
    const digest = yield* Digest.Digest;
    const sha256 = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(prepared.text));
    return {
        ...file,
        text: prepared.text,
        statements: prepared.statements,
        sha256,
    };
});
/** Refuses when a migration that already ran has changed or is gone. */
const refuseChanged = (recorded, files) => {
    const problems = recorded.flatMap((r) => {
        const file = files.find((f) => f.feature === r.feature && f.number === r.number);
        if (file === undefined)
            return [
                `${r.feature} migration ${r.number} ran here but is not in the feature's files`,
            ];
        if (file.sha256 !== r.sha256)
            return [`${r.feature} migration ${r.number} changed after it ran here`];
        return [];
    });
    return problems.length === 0
        ? Effect.void
        : Effect.fail(new DeliveryRefused({ reason: problems.join('; ') }));
};
const quoteIdentifier = (name) => `"${name.replaceAll('"', '""')}"`;
const placeholders = (roles) => new Map([
    [':DATABASE_OWNER', quoteIdentifier(roles.owner)],
    [':DATABASE_VISITOR', quoteIdentifier(roles.visitor)],
    [':DATABASE_AUTHENTICATOR', quoteIdentifier(roles.api)],
]);
/** A fixed key, so that runners on one database wait for each other. */
const lockKey = 7_046_253_118;
/**
 * The runner's own objects. They must stay valid for every later version of
 * the runner: add to them, never change them.
 */
const bootstrapSql = `
-- Postgres lets PUBLIC execute every new function unless the creating role's
-- default privileges say otherwise (check C4). The runner runs as the owner,
-- so this covers every function a feature creates.
alter default privileges revoke execute on functions from public;
create schema if not exists stompbox;
revoke all on schema stompbox from public;
create table if not exists stompbox.migrations (
  feature text not null,
  number integer not null,
  name text not null,
  sha256 text not null,
  ran_at timestamptz not null default now(),
  primary key (feature, number)
);
create or replace function stompbox.feature_versions()
  returns table (feature text, version integer)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
as $$ select feature, max(number) from stompbox.migrations group by feature $$;
revoke all on function stompbox.feature_versions() from public;
grant usage on schema stompbox to :DATABASE_VISITOR;
grant execute on function stompbox.feature_versions() to :DATABASE_VISITOR;
`;
