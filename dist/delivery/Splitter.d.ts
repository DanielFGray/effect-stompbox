import { Result, Schema } from 'effect';
declare const SqlRefused_base: Schema.Class<SqlRefused, Schema.TaggedStruct<"SqlRefused", {
    readonly reason: Schema.String;
    readonly line: Schema.Int;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A migration file the runner will not run, with the reason and the line it starts on. */
export declare class SqlRefused extends SqlRefused_base {
}
/** A migration file ready to run: its text with role names filled in, and its statements. */
export interface PreparedSql {
    readonly text: string;
    readonly statements: ReadonlyArray<string>;
}
/**
 * Fills in the role placeholders and splits a migration file into single
 * statements, because `@effect/sql-pg` runs one statement at a time.
 * Refuses SQL outside the subset of the delivery design (rules 5 and 6):
 * psql meta-commands, `COPY` through the client, transaction control,
 * statements that cannot run in a transaction, `CASCADE` other than a foreign
 * key action, and a placeholder inside quoted text.
 *
 * `placeholders` maps each name, such as `:DATABASE_VISITOR`, to the quoted
 * identifier it stands for.
 */
export declare const prepareSql: (text: string, placeholders: ReadonlyMap<string, string>) => Result.Result<PreparedSql, SqlRefused>;
export {};
