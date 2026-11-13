import { auth, passwords } from '@danielfgray/stompbox/auth'
import { Feature } from '@danielfgray/stompbox/delivery'

/** The app's own migrations, delivered after the auth features they use. */
export const app = new Feature({
	name: 'app',
	dependsOn: [auth.name, passwords.name],
	directory: `${import.meta.dirname}/../migrations`,
})

/** Every feature the server needs, in the order `deliver` and the startup check read them. */
export const features = [auth, passwords, app]
