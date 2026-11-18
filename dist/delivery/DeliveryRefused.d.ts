import { Schema } from 'effect';
declare const DeliveryRefused_base: Schema.Class<DeliveryRefused, Schema.TaggedStruct<"DeliveryRefused", {
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The runner refused to deliver, before it changed anything. */
export declare class DeliveryRefused extends DeliveryRefused_base {
}
export {};
