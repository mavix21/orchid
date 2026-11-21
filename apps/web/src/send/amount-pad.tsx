import { DeleteIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { FieldError } from "@workspace/ui/components/field";
import { type Amount, type Asset, formatAmount } from "@workspace/wallet";
import * as Option from "effect/Option";

import { TokenIcon } from "@/components/token-icon";

import { amountLabel, assetCode } from "./money";

const amountPattern = /^(0|[1-9][0-9]*)?(\.[0-9]{0,7})?$/;

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"];

const typedAmount = (current: string, typed: string) => {
  const next = typed.replace(",", ".");
  const normalized = next.startsWith(".") ? `0${next}` : next;

  return normalized.length <= 20 && amountPattern.test(normalized)
    ? normalized
    : current;
};

export function AmountPad({
  amount,
  problem,
  asset,
  available,
  field,
  onAmount,
}: {
  amount: string;
  problem: Option.Option<string>;
  asset: Asset;
  available: Amount;
  field: React.Ref<HTMLInputElement>;
  onAmount: (amount: string) => void;
}) {
  const type = (typed: string) => onAmount(typedAmount(amount, typed));

  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <div className="flex w-full items-baseline justify-center gap-2">
          <input
            id="amount"
            name="amount"
            ref={field}
            value={amount}
            onChange={(event) => type(event.target.value)}
            inputMode="none"
            autoComplete="off"
            autoFocus
            placeholder="0"
            size={Math.max(amount.length, 1)}
            aria-invalid={Option.isSome(problem) ? true : undefined}
            aria-describedby={
              Option.isSome(problem) ? "amount-error" : undefined
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
        {Option.isSome(problem) ? (
          <FieldError id="amount-error">{problem.value}</FieldError>
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
          onClick={() => onAmount(formatAmount(available))}
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
            onClick={() => type(`${amount}${key}`)}
          >
            {key}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          aria-label="Borrar"
          onClick={() => type(amount.slice(0, -1))}
        >
          <DeleteIcon />
        </Button>
      </div>
    </>
  );
}
