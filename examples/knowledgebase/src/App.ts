import { Passwords, Sessions } from '@effect-backend/auth'
import { SignedInLive } from '@effect-backend/auth/http'
import { Features } from '@effect-backend/delivery'
import { ApiPool, OwnerPool, Visitor } from '@effect-backend/visitor'
import { BunCrypto, BunServices } from '@effect/platform-bun'
import { Layer } from 'effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { AccountDirectory } from './Accounts.ts'
import { KnowledgebaseApi } from './Api.ts'
import { features } from './Feature.ts'
import { handlers } from './Handlers.ts'

// Building `Visitor` checks the role contract and refuses to start when a
// feature in the database is behind `features`; the cartridge's migrate step
// runs `migrate.ts` before the server starts.
const database = Layer.mergeAll(Visitor.layer, Sessions.layer, Passwords.layer).pipe(
	Layer.provideMerge(AccountDirectory),
	Layer.provideMerge(Layer.succeed(Features, features)),
	Layer.provideMerge(Layer.mergeAll(OwnerPool.layer, ApiPool.layer)),
	Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunCrypto.layerKdf)),
)

const api = HttpApiBuilder.layer(KnowledgebaseApi).pipe(
	Layer.provide(handlers),
	Layer.provide(SignedInLive),
)

/** The whole app without a server: `server.ts` serves it, and the tests run it in process. */
export const app = api.pipe(Layer.provideMerge(database))
