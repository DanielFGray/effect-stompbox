import { Schema } from 'effect'

/** The runner refused to deliver, before it changed anything. */
export class DeliveryRefused extends Schema.TaggedError<
	DeliveryRefused,
	{ readonly brand: unique symbol }
>()('DeliveryRefused', { reason: Schema.String }) {}
