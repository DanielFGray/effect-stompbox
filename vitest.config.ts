import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.test.ts'],
		// The visitor tests share one database and a pool of size 1.
		fileParallelism: false,
		// The test databases are on the shared server, behind an SSH tunnel.
		testTimeout: 30_000,
	},
})
