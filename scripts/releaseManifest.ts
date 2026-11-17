import { Effect, Schema } from 'effect'

/**
 * The manifest a release commit carries: the source manifest without its
 * install lifecycle scripts, key order kept.
 *
 * Consumers install a release from its git tag, and a package manager runs
 * these scripts in the consumer's install. Here `prepare` patches this repo's
 * own TypeScript (`effect-tsgo patch`): bun blocks it and reports a blocked
 * postinstall, and npm or a trusted bun runs it against the consumer.
 */
export const releaseManifest = Effect.fnUntraced(function* (text: string) {
	const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(text)
	const entries = yield* Effect.forEach(Object.entries(manifest), ([key, value]) =>
		key === 'scripts'
			? Schema.decodeUnknownEffect(Scripts)(value).pipe(
					Effect.map((scripts) => [
						key,
						Object.fromEntries(
							Object.entries(scripts).filter(([name]) => !INSTALL_SCRIPTS.has(name)),
						),
					]),
				)
			: Effect.succeed([key, value]),
	)
	return `${JSON.stringify(Object.fromEntries(entries), null, '\t')}\n`
})

const Manifest = Schema.Record(Schema.String, Schema.Unknown)
const Scripts = Schema.Record(Schema.String, Schema.String)

/** The scripts npm and bun run when they install a package from git. */
const INSTALL_SCRIPTS: ReadonlySet<string> = new Set([
	'preinstall',
	'install',
	'postinstall',
	'prepublish',
	'preprepare',
	'prepare',
	'postprepare',
])
