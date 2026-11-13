import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		// Resolves `@danielfgray/stompbox/<subpath>` to `src/` in this repo; `dist/` is for consumers.
		conditions: ['stompbox-source'],
	},
	ssr: {
		resolve: {
			conditions: ['stompbox-source'],
		},
	},
	test: {
		include: ['test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
		// The visitor tests share one database and a pool of size 1.
		fileParallelism: false,
		// The test databases are on the shared server, behind an SSH tunnel.
		testTimeout: 30_000,
	},
})
