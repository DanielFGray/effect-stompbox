import { deliver } from '@effect-backend/delivery'
import { OwnerPool } from '@effect-backend/visitor'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect, Layer } from 'effect'

import { features } from './Feature.ts'

// The cartridge's migrate step: installs or upgrades every feature, the app's
// own included, in one transaction as the owner.
deliver(features).pipe(
	Effect.provide(Layer.mergeAll(OwnerPool.sqlClient, BunServices.layer)),
	BunRuntime.runMain,
)
