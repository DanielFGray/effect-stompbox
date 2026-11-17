import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Console, Effect, FileSystem, Path, Schema, Stream } from 'effect'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'

import { releaseManifest } from './releaseManifest.ts'

/**
 * Tags the version in `package.json` at HEAD as `v<version>`, on a new commit
 * that holds the built `dist/` and a manifest without install scripts
 * (`releaseManifest`). The commit is made in a temporary detached
 * worktree, so the current branch and the main checkout do not move. Nothing
 * is pushed; the printed `git push` line is for the user.
 *
 * The clean-tree check runs before the gate, so `dist/` is built from the same
 * sources as HEAD. The tag is created last, so a failed run leaves no tag.
 */
export const release = Effect.fn('release')(function* () {
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, '..')

	const version = yield* headVersion(root)
	const tag = `v${version}`

	const status = yield* git(root, ['status', '--porcelain'])
	if (status.trim() !== '') {
		return yield* new ReleaseRefused({
			message: `the working tree is dirty; commit or remove these changes first:\n${status}`,
		})
	}

	const tagLookup = yield* gitRaw(root, [
		'rev-parse',
		'-q',
		'--verify',
		`refs/tags/${tag}`,
	])
	if (tagLookup.exitCode === 0) {
		return yield* new ReleaseRefused({ message: `tag ${tag} already exists` })
	}

	yield* gate(root)
	yield* commitTag(root, tag)

	yield* Console.log(`Created ${tag} locally. Publish it with:\n  git push origin ${tag}`)
})

/** The version at HEAD. The working tree may hold an uncommitted version bump, which must not be tagged. */
const headVersion = Effect.fnUntraced(function* (root: string) {
	const text = yield* git(root, ['show', 'HEAD:package.json'])
	const pkg = yield* Schema.decodeEffect(
		Schema.fromJsonString(
			Schema.Struct({
				version: Schema.String.check(
					Schema.isPattern(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/),
				),
			}),
		),
	)(text)
	return pkg.version
})

/** Runs the same scripts a committer runs, except the test suite, which needs the shared test databases. */
const gate = Effect.fnUntraced(function* (root: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	yield* Effect.forEach(['typecheck', 'lint', 'build'], (script) =>
		spawner
			.exitCode(
				ChildProcess.make('bun', ['run', script], {
					cwd: root,
					stdout: 'inherit',
					stderr: 'inherit',
				}),
			)
			.pipe(
				Effect.filterOrFail(
					(exitCode) => exitCode === 0,
					(exitCode) =>
						new ReleaseStepFailed({
							message: `bun run ${script} exited with code ${exitCode}; its output is above`,
						}),
				),
			),
	)
})

/**
 * Commits `dist/` on a detached worktree at HEAD, then tags that commit. The
 * worktree is removed before the temporary directory that holds it, because
 * finalizers run in reverse order of acquisition.
 */
const commitTag = Effect.fnUntraced(function* (root: string, tag: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path

	const scratch = yield* fs.makeTempDirectoryScoped({ prefix: 'stompbox-release-' })
	const tree = path.join(scratch, tag)

	yield* Effect.acquireRelease(
		git(root, ['worktree', 'add', '--detach', tree, 'HEAD']),
		() =>
			git(root, ['worktree', 'remove', '--force', tree]).pipe(
				Effect.catch((error) =>
					Console.error(`could not remove worktree ${tree}: ${error.message}`),
				),
			),
	)

	yield* fs.copy(path.join(root, 'dist'), path.join(tree, 'dist'))
	const manifest = path.join(tree, 'package.json')
	yield* fs.writeFileString(
		manifest,
		yield* releaseManifest(yield* fs.readFileString(manifest)),
	)
	yield* git(tree, ['add', '-f', 'dist', 'package.json'])
	yield* git(tree, ['commit', '-m', `release: ${tag}`])
	yield* git(tree, ['tag', '-a', tag, '-m', `release: ${tag}`])
}, Effect.scoped)

/** Runs git and fails on a non-zero exit. Returns stdout. */
const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
	const { stdout, exitCode } = yield* gitRaw(cwd, args)
	if (exitCode !== 0) {
		return yield* new GitFailed({
			message: `git ${args.join(' ')} exited with code ${exitCode}; its stderr is above`,
		})
	}
	return stdout
})

/** Runs git and returns stdout with the exit code. stderr goes to the terminal. */
const gitRaw = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(
				ChildProcess.make('git', args, { cwd, stdout: 'pipe', stderr: 'inherit' }),
			)
			return yield* Effect.all(
				{
					stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
					exitCode: handle.exitCode,
				},
				{ concurrency: 'unbounded' },
			)
		}),
	)
})

/** The working tree has changes, or the tag already exists. Nothing was changed. */
export class ReleaseRefused extends Schema.TaggedError<
	ReleaseRefused,
	{ readonly brand: unique symbol }
>()('ReleaseRefused', {
	message: Schema.String,
}) {}

/** A gate script exited non-zero. The script's own output is already on the terminal. */
export class ReleaseStepFailed extends Schema.TaggedError<
	ReleaseStepFailed,
	{ readonly brand: unique symbol }
>()('ReleaseStepFailed', {
	message: Schema.String,
}) {}

/** A git command exited non-zero. Its stderr is already on the terminal. */
export class GitFailed extends Schema.TaggedError<
	GitFailed,
	{ readonly brand: unique symbol }
>()('GitFailed', {
	message: Schema.String,
}) {}

BunRuntime.runMain(release().pipe(Effect.provide(BunServices.layer)))
