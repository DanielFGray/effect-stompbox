import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.test.ts'],
		// The visitor tests share one database and a pool of size 1.
		fileParallelism: false,
	},
})
