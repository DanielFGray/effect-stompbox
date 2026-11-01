import { BunHttpServer, BunRuntime } from '@effect/platform-bun'
import { Config, Layer } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'

import { app } from './App.ts'

HttpRouter.serve(app).pipe(
	Layer.provide(BunHttpServer.layerConfig({ port: Config.Port('PORT') })),
	Layer.launch,
	BunRuntime.runMain,
)
