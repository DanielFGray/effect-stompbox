/**
 * The text to show for a failed API call: a decoded API error's own message,
 * with the trace id for `InternalError`, or fixed text for a transport failure
 * or any value that is not an error with a message, such as a form field
 * library's own text. App code that treats one refusal
 * differently matches its `_tag` first.
 */
export declare const errorMessage: (error: unknown) => string;
