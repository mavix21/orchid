import { env } from "cloudflare:workers";
import { databaseLayer } from "@workspace/db";

export { makeDatabase } from "@workspace/db";

export function requestDatabaseLayer() {
  return databaseLayer(env.HYPERDRIVE);
}
