import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const apps = [
	'graphile-starter-slim',
	'effect-web-template',
	'setlist',
	'postgres.garden',
	'dfg.rocks',
]
const files = (dir: string): string[] =>
	!existsSync(dir)
		? []
		: readdirSync(dir)
				.sort()
				.flatMap((f) => {
					const p = join(dir, f)
					return statSync(p).isDirectory() ? files(p) : p.endsWith('.sql') ? [p] : []
				})
const re =
	/create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_]+\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi
const norm = (s: string) =>
	s
		.replace(/--[^\n]*/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
const table: Record<string, Record<string, string>> = {}
for (const app of apps) {
	const root = join(process.env.HOME!, 'build', app, 'migrations')
	const all = [
		...files(join(root, 'committed')),
		...files(join(root, 'current')),
		...(existsSync(join(root, 'current.sql')) ? [join(root, 'current.sql')] : []),
	]
	for (const f of all)
		for (const m of readFileSync(f, 'utf8').matchAll(re)) {
			;(table[m[1]!.toLowerCase()] ??= {})[app] = createHash('sha1')
				.update(norm(m[4]!))
				.digest('hex')
				.slice(0, 6)
		}
}
const names = Object.keys(table)
	.filter(
		(n) =>
			Object.keys(table[n]!).filter((a) => a !== 'graphile-starter-slim').length >= 3,
	)
	.sort()
console.log(['function', ...apps.map((a) => a.slice(0, 10))].join('\t'))
for (const n of names) {
	const row = table[n]!
	const ids = new Map<string, string>()
	let k = 0
	console.log(
		[
			n.padEnd(30),
			...apps.map((a) =>
				row[a]
					? (ids.get(row[a]!) ??
						(ids.set(row[a]!, String.fromCharCode(65 + k++)), ids.get(row[a]!)!))
					: '-',
			),
		].join('\t'),
	)
}
