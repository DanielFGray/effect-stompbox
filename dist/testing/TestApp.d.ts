import { BunServices } from '@effect/platform-bun';
import { Context, Effect, Layer, Schema } from 'effect';
import * as Digest from 'effect/crypto/Digest';
import type * as HttpApi from 'effect/http-api/HttpApi';
import * as HttpApiClient from 'effect/http-api/HttpApiClient';
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as HttpRouter from 'effect/http/HttpRouter';
import { Finding } from '../checker/index.ts';
import { type Feature } from '../delivery/index.ts';
import { OwnerPool } from '../visitor/index.ts';
declare const TestApp_base: Context.ServiceClass<TestApp, "@danielfgray/stompbox/testing/TestApp", {
    /**
     * Sends one request to the app in process and returns its response. An
     * error or defect in the app becomes a response, as a server would send.
     */
    readonly send: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}>;
/**
 * An app running in process on a test database. `TestApp.layer` builds it;
 * `TestApp.client` gives a typed client that acts as one browser.
 */
export declare class TestApp extends TestApp_base {
    /**
     * Resets the test database, delivers `features`, runs the checker, then
     * builds `app` (an `HttpApiBuilder.layer` with its handlers and database
     * layers) behind an in-process router.
     *
     * - Reset refuses a database whose name does not end in `_test`
     *   (`NotATestDatabase`), then drops every schema the owner role owns
     *   except `public`. Extensions the host created stay.
     * - The checks are C1 to C8, with `surface` as the visitor surface the
     *   app approves for C3 (one line per object, as `visitorReach` prints
     *   it). Any error fails the layer with `TestDatabaseUnsafe`.
     *
     * The layer also provides the owner pool, for tests that read what a
     * request left in the database.
     */
    static layer<A, E, R>(app: Layer.Layer<A, E, R>, options: {
        readonly features: ReadonlyArray<Feature>;
        readonly surface: ReadonlyArray<string>;
    }): Layer.Layer<OwnerPool | TestApp, E | import("effect/Config").ConfigError | import("../delivery/DeliveryRefused.ts").DeliveryRefused | import("effect/Cause").NoSuchElementError | NotATestDatabase | import("effect/PlatformError").PlatformError | import("../checker/Roles.ts").RoleMissing | Schema.SchemaError | import("effect/sql/SqlError").SqlError | TestDatabaseUnsafe, Exclude<Exclude<Exclude<Exclude<HttpRouter.HttpRouter, A | HttpRouter.HttpRouter>, never>, OwnerPool>, Digest.Digest | BunServices.BunServices> | Exclude<Exclude<Exclude<Exclude<Exclude<R, import("effect/FileSystem").FileSystem | import("effect/http/Etag").Generator | import("effect/http/HttpPlatform").HttpPlatform | import("effect/Path").Path>, HttpRouter.HttpRouter>, never>, OwnerPool>, Digest.Digest | BunServices.BunServices>>;
    /**
     * A typed client for `api` with its own cookie jar, so each call gives
     * one browser. Requests go to the app in process; nothing listens on a
     * port. A defect in the app reaches the client as a 500 response.
     */
    static client<ApiId extends string, Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<ApiId, Groups>): Effect.Effect<import("effect/Types").Simplify<{ readonly [Group in Extract<Groups, {
        readonly topLevel: false;
    }> as HttpApiGroup.Identifier<Group>]: HttpApiClient.Client.GroupByEndpoint<Group, never, never>; } & HttpApiClient.Client.TopLevelMethods<Groups, never, never>>, never, TestApp | import("effect/http-api/HttpApiMiddleware").MiddlewareClient<import("effect/http-api/HttpApiEndpoint").Middleware<HttpApiGroup.Endpoints<Groups>>>>;
}
declare const NotATestDatabase_base: Schema.Class<NotATestDatabase, Schema.TaggedStruct<"NotATestDatabase", {
    readonly database: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The test database's name does not end in `_test`, so `TestApp` does not reset it. */
export declare class NotATestDatabase extends NotATestDatabase_base {
}
declare const TestDatabaseUnsafe_base: Schema.Class<TestDatabaseUnsafe, Schema.TaggedStruct<"TestDatabaseUnsafe", {
    readonly findings: Schema.$Array<typeof Finding>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The checker found errors in the delivered database. */
export declare class TestDatabaseUnsafe extends TestDatabaseUnsafe_base {
}
export {};
