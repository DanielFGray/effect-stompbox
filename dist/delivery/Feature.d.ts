import { Context, Effect, Schema } from 'effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { DeliveryRefused } from './DeliveryRefused.ts';
declare const Feature_base: Schema.Class<Feature, Schema.Struct<{
    readonly name: Schema.String;
    readonly dependsOn: Schema.$Array<Schema.String>;
    readonly directory: Schema.String;
}>, {
    readonly brand: unique symbol;
}>;
/**
 * A unit of SQL the runner delivers: a name, the features it depends on, and
 * a directory of migration files named `0001-<name>.sql`, `0002-<name>.sql`
 * and so on, numbered from 1 without gaps. The app's own migrations are a
 * feature too.
 */
export declare class Feature extends Feature_base {
}
declare const Features_base: Context.ServiceClass<Features, "@danielfgray/stompbox/delivery/Features", readonly Feature[]>;
/** The features an app uses. The runner installs them; the server checks their versions at startup. */
export declare class Features extends Features_base {
}
/** A migration file of a feature, as read from its directory. */
export interface MigrationFile {
    readonly feature: string;
    readonly number: number;
    readonly name: string;
    readonly text: string;
}
/** Reads a feature's migration files in order, and refuses a bad name or a gap in the numbers. */
export declare const readMigrations: (feature: Feature) => Effect.Effect<{
    feature: string;
    number: number;
    name: string;
    text: string;
}[], DeliveryRefused | import("effect/PlatformError").PlatformError, FileSystem.FileSystem | Path.Path>;
/**
 * Orders the features so that each comes after the features it depends on,
 * keeping the given order where dependencies allow. Refuses a missing
 * dependency or a cycle.
 */
export declare const dependencyOrder: (features: ReadonlyArray<Feature>) => Effect.Effect<ReadonlyArray<Feature>, DeliveryRefused>;
export {};
