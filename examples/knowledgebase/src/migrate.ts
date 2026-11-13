import { deliver } from '@danielfgray/stompbox/delivery'
import { OwnerPool } from '@danielfgray/stompbox/visitor'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import { SqlClient } from 'effect/sql/SqlClient'

import { features } from './Feature.ts'

// The cartridge's migrate step: installs or upgrades every feature, the app's
// own included, in one transaction as the owner. The owner pool is the
// `SqlClient` for this one call only, so no request code can run as the owner
// by asking for `SqlClient`.
Effect.flatMap(Effect.service(OwnerPool), (owner) =>
	deliver(features).pipe(Effect.provideService(SqlClient, owner)),
).pipe(
	Effect.provide([OwnerPool.layer, BunServices.layer, Digest.layerWebCrypto]),
	BunRuntime.runMain,
)
