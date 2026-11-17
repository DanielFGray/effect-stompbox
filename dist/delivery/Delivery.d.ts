import { Effect, Schema } from 'effect';
import * as Digest from 'effect/crypto/Digest';
import { SqlClient } from 'effect/sql/SqlClient';
import { Finding } from '../checker/index.ts';
import { DeliveryRefused } from './DeliveryRefused.ts';
import { type Feature } from './Feature.ts';
/** How far one run moved a feature: from its version before the run to its version after. */
export interface Delivered {
    readonly feature: string;
    readonly from: number;
    readonly to: number;
}
/**
 * Installs or upgrades `features` on the connected database, which must be
 * the owner pool (the migration login, ADR 0002). Every check runs first:
 * the dependency order, each file's SQL, the connection's role, and that no
 * migration that already ran has changed. Then every pending migration of
 * every feature runs in one transaction, under one advisory lock, each
 * feature to its latest version in dependency order. A failure leaves every
 * feature at its old version.
 */
export declare const deliver: (features: readonly Feature[]) => Effect.Effect<Delivered[], import("effect/Config").ConfigError | DeliveryRefused | import("effect/Cause").NoSuchElementError | import("effect/PlatformError").PlatformError | Schema.SchemaError | import("effect/sql/SqlError").SqlError, Digest.Digest | import("effect/FileSystem").FileSystem | import("effect/Path").Path | SqlClient>;
/**
 * Finds each feature whose version in the database is behind its latest
 * migration, as startup findings. Runs as the visitor, through
 * `stompbox.feature_versions()`. A database ahead of the code passes,
 * because the old code runs against the migrated database during a deploy.
 */
export declare const versionsBehind: (features: readonly Feature[]) => Effect.Effect<Finding[], DeliveryRefused | import("effect/PlatformError").PlatformError | Schema.SchemaError | import("effect/sql/SqlError").SqlError, import("effect/FileSystem").FileSystem | import("effect/Path").Path | SqlClient>;
