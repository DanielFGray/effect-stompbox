import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect, FileSystem, Path, Schema } from 'effect'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'

/**
 * Emits `dist/`: one `.js` and `.d.ts` per file under `src/` (plain `tsc`, no
 * bundler), then the `.sql` files that `src/auth/Feature.ts` reads at runtime,
 * at the same relative paths. `dist/` is removed first, so a file deleted from
 * `src/` cannot survive in the package.
 *
 * The `.d.ts` files keep their `./x.ts` specifiers: a consumer's TypeScript
 * resolves `./x.ts` to `./x.d.ts`.
 */
export const build = Effect.fn('build')(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const root = path.join(import.meta.dirname, '..')
	const src = path.join(root, 'src')
	const dist = path.join(root, 'dist')

	yield* fs.remove(dist, { recursive: true, force: true })

	const tscExit = yield* spawner.exitCode(
		ChildProcess.make({
			cwd: root,
			stdout: 'inherit',
			stderr: 'inherit',
		})`bunx tsc -p tsconfig.build.json`,
	)
	if (tscExit !== 0) {
		return yield* new BuildStepFailed({ step: 'tsc', exitCode: tscExit })
	}

	const sqlFiles = (yield* fs.readDirectory(src, { recursive: true })).filter((file) =>
		file.endsWith('.sql'),
	)
	yield* Effect.forEach(sqlFiles, (file) =>
		fs
			.makeDirectory(path.dirname(path.join(dist, file)), { recursive: true })
			.pipe(Effect.andThen(fs.copyFile(path.join(src, file), path.join(dist, file)))),
	)
})

/** A build step that exited non-zero. The step's own output is already on the terminal. */
export class BuildStepFailed extends Schema.TaggedError<
	BuildStepFailed,
	{ readonly brand: unique symbol }
>()('BuildStepFailed', {
	step: Schema.String,
	exitCode: Schema.Finite,
}) {}

BunRuntime.runMain(build().pipe(Effect.provide(BunServices.layer)))
