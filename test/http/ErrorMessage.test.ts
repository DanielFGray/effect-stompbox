import { assert, describe, it } from '@effect/vitest'

import { errorMessage } from '../../src/http/client/index.ts'
import { InternalError, NotFound } from '../../src/http/index.ts'

describe('errorMessage', () => {
	it('shows an API error its own message, and InternalError its trace id', () => {
		assert.strictEqual(
			errorMessage(new NotFound({ message: 'No such band.' })),
			'No such band.',
		)
		assert.strictEqual(
			errorMessage(new InternalError({ message: 'Something failed.', traceId: 'abc' })),
			'Something failed. (reference: abc)',
		)
	})

	it('shows fixed text for a value that is not an error with a message', () => {
		assert.strictEqual(
			errorMessage('Pick a key'),
			'The request could not be completed. Try again.',
		)
		assert.strictEqual(
			errorMessage(undefined),
			'The request could not be completed. Try again.',
		)
	})
})
