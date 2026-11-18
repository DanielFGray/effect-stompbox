import { Schema } from 'effect';
/** The runner refused to deliver, before it changed anything. */
export class DeliveryRefused extends Schema.TaggedError()('DeliveryRefused', { reason: Schema.String }) {
}
