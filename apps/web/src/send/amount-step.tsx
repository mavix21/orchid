import { NotebookPenIcon, UserRoundIcon, WalletIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { FieldError } from "@workspace/ui/components/field";
import {
  Amount,
  type Asset,
  type TransferIntent,
  formatAmount,
  parseAmount,
} from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { OptionRow } from "@/components/option-row";
import { ScreenActions } from "@/components/screen";
import { TokenIcon } from "@/components/token-icon";

import {
  type Destination,
  type FieldProblem,
  type SendField,
  type SendForm,
  intentOf,
} from "./intent";
import { MemoDrawer } from "./memo-drawer";
import { amountLabel, assetCode, shortAddress } from "./money";

const shares = [
  { label: "25%", percent: 25n },
  { label: "50%", percent: 50n },
  { label: "75%", percent: 75n },
  { label: "Máx", percent: 100n },
];

const shareOf = (available: Amount, percent: bigint) =>
  formatAmount(
    Schema.decodeSync(Amount)(((available * percent) / 100n).toString()),
  );

const messageFor = (problem: Option.Option<FieldProblem>, field: SendField) =>
  problem.pipe(
    Option.filter((found) => found.field === field),
    Option.map((found) => found.message),
  );

export function AmountStep({
  destination,
  form,
  problem,
  asset,
  available,
  onEdit,
  onIntent,
  onProblem,
  onChangeRecipient,
}: {
  destination: Destination;
  form: SendForm;
  problem: Option.Option<FieldProblem>;
  asset: Asset;
  available: Amount;
  onEdit: (field: SendField, value: string) => void;
  onIntent: (intent: TransferIntent) => void;
  onProblem: (problem: FieldProblem) => void;
  onChangeRecipient: () => void;
}) {
  const amountField = useRef<HTMLInputElement>(null);
  const memoProblem = messageFor(problem, "memo");
  const amountProblem = messageFor(problem, "amount");
  const [memoOpen, setMemoOpen] = useState(Option.isSome(memoProblem));

  useEffect(() => {
    if (Option.isSome(memoProblem)) setMemoOpen(true);

    if (Option.isSome(amountProblem)) amountField.current?.focus();
  }, [problem]);

  const typed = form.amount.trim().replace(",", ".");
  const entered = Option.isSome(parseAmount(typed));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Result.match(intentOf(form, destination, asset), {
      onFailure: onProblem,
      onSuccess: onIntent,
    });
  };

  return (
    <>
      <form className="flex flex-1 flex-col" noValidate onSubmit={submit}>
        <main className="flex flex-1 flex-col gap-4 px-5 pt-2">
          <OptionRow
            title={
              destination === "username"
                ? `@${form.recipient.trim()}`
                : shortAddress(form.recipient.trim())
            }
            description={
              destination === "username"
                ? "Usuario de Orchid"
                : "Dirección Stellar"
            }
            media={
              destination === "username" ? <UserRoundIcon /> : <WalletIcon />
            }
            render={<button type="button" onClick={onChangeRecipient} />}
          />
          <section
            aria-label="Monto"
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
          >
            <div className="flex items-center justify-between gap-3 text-body text-muted-foreground">
              <label htmlFor="amount">Enviando</label>
              <span>{amountLabel(available, asset)} disponibles</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                id="amount"
                name="amount"
                ref={amountField}
                value={form.amount}
                onChange={(event) => onEdit("amount", event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                aria-invalid={Option.isSome(amountProblem) ? true : undefined}
                aria-describedby={
                  Option.isSome(amountProblem) ? "amount-error" : undefined
                }
                className="min-w-0 flex-1 bg-transparent font-display text-display outline-none placeholder:text-muted-foreground"
              />
              <span className="flex items-center gap-2 rounded-full bg-secondary px-3 py-2 text-label-lg">
                <TokenIcon asset={asset} />
                {assetCode(asset)}
              </span>
            </div>
            {Option.isSome(amountProblem) ? (
              <FieldError id="amount-error">{amountProblem.value}</FieldError>
            ) : null}
          </section>
          <div className="grid grid-cols-4 gap-2">
            {shares.map((share) => (
              <Button
                key={share.label}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  onEdit("amount", shareOf(available, share.percent))
                }
              >
                {share.label}
              </Button>
            ))}
          </div>
        </main>
        <ScreenActions>
          <div className="flex w-full items-center justify-between gap-3">
            <p className="text-body text-muted-foreground">
              Orchid paga la comisión
            </p>
            {destination === "address" ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setMemoOpen(true)}
              >
                <NotebookPenIcon />
                {form.memo === "" ? "Memo" : "Memo agregado"}
              </Button>
            ) : null}
          </div>
          <Button className="w-full" type="submit" disabled={!entered}>
            {entered ? "Revisar" : "Escribe un monto"}
          </Button>
        </ScreenActions>
      </form>
      {destination === "address" ? (
        <MemoDrawer
          open={memoOpen}
          memo={form.memo}
          problem={memoProblem}
          onOpenChange={setMemoOpen}
          onSave={(memo) => onEdit("memo", memo)}
        />
      ) : null}
    </>
  );
}
