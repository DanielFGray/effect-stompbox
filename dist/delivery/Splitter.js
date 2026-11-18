import { Result, Schema } from 'effect';
/** A migration file the runner will not run, with the reason and the line it starts on. */
export class SqlRefused extends Schema.TaggedError()('SqlRefused', { reason: Schema.String, line: Schema.Int }) {
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
export const prepareSql = (text, placeholders) => Result.gen(function* () {
    const segments = yield* lex(text);
    const filled = yield* Result.all(segments.map((segment) => fill(segment, placeholders)));
    const statements = splitStatements(filled);
    yield* Result.all(statements.map(refuseOutsideSubset));
    return {
        text: filled.map((s) => s.text).join(''),
        statements: statements.map((s) => s.text.trim()),
    };
});
const placeholderPattern = /(?<!:):DATABASE_[A-Z_]+\b/g;
/** Replaces placeholders in code; refuses an unknown one, or one inside quoted text. */
const fill = (segment, placeholders) => {
    const found = segment.text.match(placeholderPattern) ?? [];
    if (segment.kind === 'comment' || found.length === 0)
        return Result.succeed(segment);
    if (segment.kind === 'quoted')
        return Result.fail(new SqlRefused({
            reason: `placeholder ${found[0]} inside quoted text; read the role name from a function instead`,
            line: segment.line,
        }));
    const unknown = found.find((name) => !placeholders.has(name));
    if (unknown !== undefined)
        return Result.fail(new SqlRefused({ reason: `unknown placeholder ${unknown}`, line: segment.line }));
    return Result.succeed({
        ...segment,
        text: segment.text.replace(placeholderPattern, (name) => placeholders.get(name) ?? name),
    });
};
/** Cuts the segments at each `;` in code into statements, dropping those with no code. */
const splitStatements = (segments) => {
    const statements = [];
    let text = '';
    let code = '';
    // The line the current statement starts on; 0 until it has code.
    let line = 0;
    let at = 1;
    const take = (kind, part) => {
        if (line === 0 && (kind === 'quoted' || (kind === 'code' && part.trim() !== '')))
            line = at + (kind === 'code' ? leadingLines(part) : 0);
        text += part;
        code += kind === 'code' ? part : kind === 'quoted' ? ' _ ' : ' ';
        at += countLines(part);
    };
    const end = () => {
        if (line !== 0)
            statements.push({
                text,
                code: code.trim().replace(/\s+/g, ' ').toLowerCase(),
                line,
            });
        text = '';
        code = '';
        line = 0;
    };
    for (const segment of segments) {
        if (segment.kind !== 'code')
            take(segment.kind, segment.text);
        else
            segment.text.split(';').forEach((part, i, parts) => {
                take('code', part);
                if (i < parts.length - 1)
                    end();
            });
    }
    end();
    return statements;
};
const refusals = [
    [/^\\|\n\s*\\/, 'psql meta-command'],
    [/^copy\b.*\b(stdin|stdout)\b/, 'COPY through the client'],
    [
        /^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction)\b/,
        'transaction control; the runner owns the transaction',
    ],
    [/\bconcurrently\b/, 'CONCURRENTLY cannot run in a transaction'],
    [
        /^(vacuum|create database|drop database|alter system|create tablespace|drop tablespace)\b/,
        'cannot run in a transaction',
    ],
];
const refuseOutsideSubset = (statement) => {
    const cascade = /\bcascade\b/.test(statement.code.replace(/\bon (delete|update) cascade\b/g, ''));
    const reason = cascade
        ? 'CASCADE would silently drop dependent objects, such as an app policy'
        : refusals.find(([pattern]) => pattern.test(statement.code))?.[1];
    return reason === undefined
        ? Result.void
        : Result.fail(new SqlRefused({ reason, line: statement.line }));
};
/**
 * Cuts SQL text into code, quoted text and comments, following Postgres's
 * lexical rules: `'…'` strings (backslash escapes only after `E`), `"…"`
 * identifiers, `$tag$…$tag$` bodies, `--` comments and nested `/* *\/`
 * comments. A `$` after an identifier character is part of the identifier.
 */
const lex = (text) => {
    const segments = [];
    let line = 1;
    let start = 0;
    let i = 0;
    const push = (kind, end) => {
        if (end > start)
            segments.push({ kind, text: text.slice(start, end), line });
        line += countLines(text.slice(start, end));
        start = end;
    };
    const unterminated = (what) => Result.fail(new SqlRefused({
        reason: `unterminated ${what}`,
        line: line + countLines(text.slice(start, i)),
    }));
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (c === '-' && next === '-') {
            push('code', i);
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end;
            push('comment', i);
        }
        else if (c === '/' && next === '*') {
            push('code', i);
            let depth = 0;
            do {
                if (text.startsWith('/*', i)) {
                    depth++;
                    i += 2;
                }
                else if (text.startsWith('*/', i)) {
                    depth--;
                    i += 2;
                }
                else
                    i++;
            } while (depth > 0 && i < text.length);
            if (depth > 0)
                return unterminated('comment');
            push('comment', i);
        }
        else if (c === "'" || c === '"') {
            const escapes = c === "'" && /[eE]/.test(text[i - 1] ?? '') && !isIdentifierChar(text[i - 2]);
            push('code', escapes ? i - 1 : i);
            i++;
            for (;;) {
                if (i >= text.length)
                    return unterminated(c === "'" ? 'string' : 'quoted identifier');
                if (escapes && text[i] === '\\')
                    i += 2;
                else if (text[i] === c && text[i + 1] === c)
                    i += 2;
                else if (text[i] === c)
                    break;
                else
                    i++;
            }
            i++;
            push('quoted', i);
        }
        else if (c === '$' && !isIdentifierChar(text[i - 1])) {
            const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))?.[0];
            if (tag === undefined)
                i++;
            else {
                push('code', i);
                const end = text.indexOf(tag, i + tag.length);
                if (end === -1)
                    return unterminated(`${tag} body`);
                i = end + tag.length;
                push('quoted', i);
            }
        }
        else
            i++;
    }
    push('code', i);
    return Result.succeed(segments);
};
const isIdentifierChar = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const countLines = (s) => s.split('\n').length - 1;
const leadingLines = (s) => countLines(s.slice(0, s.length - s.trimStart().length));
