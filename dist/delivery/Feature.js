import { Context, Effect, Schema } from 'effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { DeliveryRefused } from './DeliveryRefused.js';
/**
 * A unit of SQL the runner delivers: a name, the features it depends on, and
 * a directory of migration files named `0001-<name>.sql`, `0002-<name>.sql`
 * and so on, numbered from 1 without gaps. The app's own migrations are a
 * feature too.
 */
export class Feature extends Schema.Class('Feature')({
    name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)),
    dependsOn: Schema.Array(Schema.String),
    directory: Schema.String,
}) {
}
/** The features an app uses. The runner installs them; the server checks their versions at startup. */
export class Features extends Context.Service()('@danielfgray/stompbox/delivery/Features') {
}
/** Reads a feature's migration files in order, and refuses a bad name or a gap in the numbers. */
export const readMigrations = Effect.fnUntraced(function* (feature) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = (yield* fs.readDirectory(feature.directory))
        .filter((n) => n.endsWith('.sql'))
        .sort();
    return yield* Effect.forEach(names, (file, i) => Effect.gen(function* () {
        const match = /^(\d{4})-([a-z0-9_-]+)\.sql$/.exec(file);
        const number = Number(match?.[1]);
        if (match === null || number !== i + 1)
            return yield* new DeliveryRefused({
                reason: `${feature.name}/${file}: expected ${String(i + 1).padStart(4, '0')}-<name>.sql`,
            });
        const text = yield* fs.readFileString(path.join(feature.directory, file));
        return {
            feature: feature.name,
            number,
            name: match[2] ?? '',
            text,
        };
    }));
});
/**
 * Orders the features so that each comes after the features it depends on,
 * keeping the given order where dependencies allow. Refuses a missing
 * dependency or a cycle.
 */
export const dependencyOrder = (features) => Effect.gen(function* () {
    const byName = new Map(features.map((f) => [f.name, f]));
    if (byName.size !== features.length)
        return yield* new DeliveryRefused({ reason: 'two features have the same name' });
    const ordered = [];
    const visit = (feature, path) => {
        if (ordered.includes(feature))
            return undefined;
        if (path.includes(feature.name))
            return `dependency cycle: ${[...path.slice(path.indexOf(feature.name)), feature.name].join(' -> ')}`;
        for (const name of feature.dependsOn) {
            const dependency = byName.get(name);
            if (dependency === undefined)
                return `${feature.name} depends on ${name}, which is not listed`;
            const problem = visit(dependency, [...path, feature.name]);
            if (problem !== undefined)
                return problem;
        }
        ordered.push(feature);
        return undefined;
    };
    for (const feature of features) {
        const problem = visit(feature, []);
        if (problem !== undefined)
            return yield* new DeliveryRefused({ reason: problem });
    }
    return ordered;
});
