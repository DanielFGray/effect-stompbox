import { Schema } from 'effect'
import { isHttpClientError } from 'effect/http/HttpClientError'

import { InternalError } from '../index.ts'

/**
 * The text to show for a failed API call: a decoded API error's own message,
 * with the trace id for `InternalError`, or fixed text for a transport failure
 * or any error without a message. App code that treats one refusal
 * differently matches its `_tag` first.
 */
export const errorMessage = (error: { readonly _tag: string }) => {
	if (isHttpClientError(error)) return fallback
	if (isInternalError(error)) return `${error.message} (reference: ${error.traceId})`
	return Schema.is(HasMessage)(error) ? error.message : fallback
}

const fallback = 'The request could not be completed. Try again.'
const HasMessage = Schema.Struct({ message: Schema.String })
const isInternalError = Schema.is(InternalError)
