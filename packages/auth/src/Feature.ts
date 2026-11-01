import { Feature } from '@effect-backend/delivery'

/**
 * The feature `auth`: the users and sessions tables and the session bridge
 * functions (ADR 0004). Every other auth feature depends on it.
 */
export const auth = new Feature({
	name: 'auth',
	dependsOn: [],
	directory: `${import.meta.dirname}/../migrations`,
})
