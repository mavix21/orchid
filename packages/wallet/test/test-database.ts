import { databaseLayer } from "@workspace/db";

export const dbLayer = databaseLayer({
  connectionString:
    "postgres://orchid:orchid-local@127.0.0.1:55433/wallet_test",
});
