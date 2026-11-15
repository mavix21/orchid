import { PgClient } from "@effect/sql-pg";
import * as Redacted from "effect/Redacted";

export { makeWithDefaults as makeDatabase } from "drizzle-orm/effect-postgres";

/** Build inside the request; provide this layer to the database Effect program. */
export function databaseLayer(hyperdrive: { readonly connectionString: string }) {
  return PgClient.layer({ url: Redacted.make(hyperdrive.connectionString) });
}
