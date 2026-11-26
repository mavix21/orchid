import type { PaymentReview } from "@workspace/wallet";
import { formatAmount, precisionOf } from "@workspace/wallet";

import { assetCode, shortAddress } from "./money";

export function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className="text-right text-label-lg">{children}</dd>
    </div>
  );
}

export function PaymentReviewCard({ review }: { review: PaymentReview }) {
  const address = shortAddress(review.to);
  const asset = assetCode(review.asset);
  const amount = formatAmount(review.amount, precisionOf(review.asset));

  return (
    <div className="flex flex-col gap-4">
      <dl
        aria-label="Resumen del pago"
        className="flex flex-col divide-y divide-border rounded-lg border border-border px-4"
        data-testid="payment-summary"
        data-username={review.username}
        data-asset={asset}
        data-amount={amount}
      >
        <ReviewRow label="Para">
          {review.username === undefined ? (
            <span className="flex flex-col items-end">
              <span>{address}</span>
              {review.memoRequired ? (
                <span className="text-caption text-muted-foreground">
                  Este exchange requiere memo
                </span>
              ) : null}
            </span>
          ) : (
            <span className="flex flex-col items-end">
              <span>@{review.username}</span>
              <span className="text-caption text-muted-foreground">
                {address}
              </span>
            </span>
          )}
        </ReviewRow>
        <ReviewRow label="Activo">{asset}</ReviewRow>
        <ReviewRow label="Monto">{amount}</ReviewRow>
        {review.memo === undefined ? null : (
          <ReviewRow label="Memo">
            <span className="break-all whitespace-pre-wrap">
              {review.memo.value}
            </span>
          </ReviewRow>
        )}
        <ReviewRow label="Comisión">Orchid paga la comisión</ReviewRow>
      </dl>
      {review.claimable ? (
        <p className="text-body text-muted-foreground">
          {review.username === undefined ? address : `@${review.username}`}{" "}
          tiene que aceptarlo para recibirlo.
        </p>
      ) : null}
    </div>
  );
}
