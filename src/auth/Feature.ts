import { Feature } from '../delivery/index.ts'

/**
 * The feature `auth`: the users and sessions tables and the session bridge
 * functions (ADR 0004). Every other auth feature depends on it.
 */
export const auth = new Feature({
	name: 'auth',
	dependsOn: [],
	directory: `${import.meta.dirname}/migrations`,
})

/**
 * The feature `passwords`: Argon2id password hashes in SQL, the failure count
 * and the lockout. Needs the extension `pgsodium`, which the host creates.
 */
export const passwords = new Feature({
	name: 'passwords',
	dependsOn: ['auth'],
	directory: `${import.meta.dirname}/passwords`,
})
