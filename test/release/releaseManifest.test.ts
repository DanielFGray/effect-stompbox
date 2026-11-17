import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { releaseManifest } from '../../scripts/releaseManifest.ts'

describe('releaseManifest', () => {
	it.effect('drops the install scripts and keeps every other key in order', () =>
		Effect.gen(function* () {
			const source = {
				name: '@danielfgray/stompbox',
				version: '0.1.1',
				scripts: {
					build: 'bun scripts/build.ts',
					prepare: 'effect-tsgo patch',
					postinstall: 'x',
				},
				exports: { '.': './dist/index.js' },
			}
			const text = yield* releaseManifest(JSON.stringify(source, null, '\t'))
			expect(text).toBe(
				`${JSON.stringify(
					{
						name: '@danielfgray/stompbox',
						version: '0.1.1',
						scripts: { build: 'bun scripts/build.ts' },
						exports: { '.': './dist/index.js' },
					},
					null,
					'\t',
				)}\n`,
			)
		}),
	)

	it.effect('leaves a manifest with no scripts unchanged', () =>
		Effect.gen(function* () {
			const text = `${JSON.stringify({ name: 'a', version: '1.0.0' }, null, '\t')}\n`
			expect(yield* releaseManifest(text)).toBe(text)
		}),
	)
})
