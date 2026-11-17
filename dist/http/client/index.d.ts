/**
 * The text to show for a failed API call: a decoded API error's own message,
 * with the trace id for `InternalError`, or fixed text for a transport failure
 * or any error without a message. App code that treats one refusal
 * differently matches its `_tag` first.
 */
export declare const errorMessage: (error: {
    readonly _tag: string;
}) => string;
