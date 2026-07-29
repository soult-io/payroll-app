/**
 * Regression test for the 2026-07-29 production crash (`Buffer.byteLength(Date)`
 * in postgres-js Bind during create-admin).
 *
 * Root cause: `drizzle(sql)` MUTATES its postgres-js client's type
 * serializers to identity for date/timestamp/JSON OIDs (drizzle maps those
 * types itself). Better Auth's kysely adapter sends raw `Date` parameters;
 * sharing that mutated client meant the Date reached the wire encoder
 * unserialized. The fix is two separate clients — this test pins that
 * invariant. It needs no live database: `postgres()` connects lazily and
 * `options` is inspectable synchronously.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";

type Serializers = Record<string, (value: unknown) => unknown>;

function serializersOf(client: unknown): Serializers {
  return (client as { options: { serializers: Serializers } }).options.serializers;
}

describe("createDb client separation (drizzle serializer mutation regression)", () => {
  it("the drizzle client is identity-mutated; the Better Auth client serializes Dates", async () => {
    const database = createDb(loadConfig());
    const clients = database.clients!;
    const date = new Date("2026-07-29T20:00:00Z");

    // Two DISTINCT clients — sharing one is the bug.
    expect(clients.auth).not.toBe(clients.drizzle);

    // drizzle mutates ITS client to identity for timestamptz (documents the
    // upstream behavior we must isolate).
    expect(serializersOf(clients.drizzle)["1184"]!(date)).toBe(date);

    // The auth (kysely / Better Auth) client must keep the default serializer:
    // a Date goes to the wire as an ISO string, never as a raw Date.
    expect(serializersOf(clients.auth)["1184"]!(date)).toBe("2026-07-29T20:00:00.000Z");

    await database.close();
  });
});
