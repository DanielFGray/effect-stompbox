import { Passwords, Sessions } from '@danielfgray/stompbox/auth'
import { SignedInLive } from '@danielfgray/stompbox/auth/http'
import { Features } from '@danielfgray/stompbox/delivery'
import { FailureBoundaryLayer } from '@danielfgray/stompbox/http/server'
import { ApiPool, OwnerPool, Visitor } from '@danielfgray/stompbox/visitor'
import { BunServices } from '@effect/platform-bun'
import { Layer } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { FailureBoundary, KnowledgebaseApi } from './Api.ts'
import { toHttpError } from './dbErrors.ts'
import { features } from './Feature.ts'
import { handlers } from './Handlers.ts'

// Building `Visitor` checks the role contract and refuses to start when a
// feature in the database is behind `features`; the cartridge's migrate step
// runs `migrate.ts` before the server starts.
const database = Layer.mergeAll(Visitor.layer, Passwords.layer).pipe(
	Layer.provideMerge(Sessions.layer),
	Layer.provideMerge(Layer.succeed(Features, features)),
	Layer.provideMerge(Layer.mergeAll(OwnerPool.layer, ApiPool.layer)),
	Layer.provideMerge(
		Layer.mergeAll(BunServices.layer, Digest.layerWebCrypto, SecureRandom.layerWebCrypto),
	),
)

const api = HttpApiBuilder.layer(KnowledgebaseApi).pipe(
	Layer.provide(handlers),
	Layer.provide(SignedInLive),
	Layer.provide(FailureBoundaryLayer.make(FailureBoundary, toHttpError)),
)

/** The whole app without a server: `server.ts` serves it, and the tests run it in process. */
export const app = api.pipe(Layer.provideMerge(database))
