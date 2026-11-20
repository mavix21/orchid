import { DeleteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { FieldError } from "@workspace/ui/components/field";
import {
  type Amount,
  type Asset,
  type TransferIntent,
  formatAmount,
  parseAmount,
} from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

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

const amountPattern = /^(0|[1-9][0-9]*)?(\.[0-9]{0,7})?$/;

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"];

const typedAmount = (current: string, typed: string) => {
  const next = typed.replace(",", ".");
  const normalized = next.startsWith(".") ? `0${next}` : next;

  return normalized.length <= 20 && amountPattern.test(normalized)
    ? normalized
    : current;
};

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

  const entered = Option.isSome(parseAmount(form.amount));

  const type = (typed: string) =>
    onEdit("amount", typedAmount(form.amount, typed));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Result.match(intentOf(form, destination, asset), {
      onFailure: onProblem,
      onSuccess: onIntent,
    });
  };

  const recipient = form.recipient.trim();

  return (
    <>
      <form className="flex flex-1 flex-col" noValidate onSubmit={submit}>
        <main className="flex flex-1 flex-col gap-4 px-5 pt-2">
          <button
            type="button"
            onClick={onChangeRecipient}
            aria-label="Cambiar destinatario"
            className="flex items-center gap-3 rounded-lg bg-secondary px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="text-body text-muted-foreground">Para</span>
            <span className="truncate text-label-lg">
              {destination === "username"
                ? `@${recipient}`
                : shortAddress(recipient)}
            </span>
          </button>
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <div className="flex w-full items-baseline justify-center gap-2">
              <input
                id="amount"
                name="amount"
                ref={amountField}
                value={form.amount}
                onChange={(event) => type(event.target.value)}
                inputMode="none"
                autoComplete="off"
                autoFocus
                placeholder="0"
                size={Math.max(form.amount.length, 1)}
                aria-invalid={Option.isSome(amountProblem) ? true : undefined}
                aria-describedby={
                  Option.isSome(amountProblem) ? "amount-error" : undefined
                }
                className="max-w-full min-w-0 field-sizing-content bg-transparent text-right font-display text-display tracking-normal caret-muted-foreground outline-none placeholder:text-muted-foreground"
              />
              <label
                htmlFor="amount"
                className="font-display text-h1 text-muted-foreground"
              >
                <span className="sr-only">Monto en </span>
                {assetCode(asset)}
              </label>
            </div>
            {Option.isSome(amountProblem) ? (
              <FieldError id="amount-error">{amountProblem.value}</FieldError>
            ) : null}
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
            <TokenIcon asset={asset} />
            <div className="flex flex-1 flex-col">
              <span className="text-label-lg">{assetCode(asset)}</span>
              <span className="text-body text-muted-foreground">
                {amountLabel(available, asset)} disponibles
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onEdit("amount", formatAmount(available))}
            >
              Usar todo
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {keys.map((key) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                onClick={() => type(`${form.amount}${key}`)}
              >
                {key}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              aria-label="Borrar"
              onClick={() => type(form.amount.slice(0, -1))}
            >
              <DeleteIcon />
            </Button>
          </div>
        </main>
        <ScreenActions>
          <div className="flex w-full gap-2">
            {destination === "address" ? (
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setMemoOpen(true)}
              >
                {form.memo === "" ? "Agregar memo" : "Editar memo"}
              </Button>
            ) : null}
            <Button className="flex-1" type="submit" disabled={!entered}>
              Revisar
            </Button>
          </div>
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
