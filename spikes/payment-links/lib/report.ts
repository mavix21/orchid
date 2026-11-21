import { horizon, pause } from "./network";
import type { Outcome } from "./outcome";

export type Notes = Readonly<Record<string, string | number | boolean>>;

const ingested = async (ledger: number): Promise<void> => {
  const latest = await horizon.ledgers().order("desc").limit(1).call();

  if ((latest.records[0]?.sequence ?? 0) >= ledger) return;

  await pause(1_000);

  return ingested(ledger);
};

export const settle = async (outcome: Outcome): Promise<Outcome> => {
  if (outcome.ledger !== undefined) await ingested(outcome.ledger);

  return outcome;
};

export const emit = (
  proof: string,
  step: string,
  outcome?: Outcome,
  notes?: Notes,
) => {
  console.log(JSON.stringify({ proof, step, ...outcome, ...notes }));
};
