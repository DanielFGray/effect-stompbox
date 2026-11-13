import { DatabaseAnswers } from '@danielfgray/stompbox/http/server'

/**
 * What a database refusal means to a client. The app's own refusals are mapped
 * in its services with `onSqlState`, so no custom code or constraint is listed
 * here; the package answers the standard codes.
 */
export const toHttpError = DatabaseAnswers.make({ codes: {}, constraints: {} })
