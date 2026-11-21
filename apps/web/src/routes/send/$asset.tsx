import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from "@tanstack/react-router";
import { TransferId, assetKey } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { Screen } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { assetCode } from "@/send/money";
import { SendFlow } from "@/send/send-flow";
import { SendUnavailable } from "@/send/send-unavailable";
import { shownOverview } from "@/wallet/shown-overview";

const TransferSearch = Schema.Struct({ transfer: Schema.optional(TransferId) });

export const Route = createFileRoute("/send/$asset")({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(TransferSearch),
  shouldReload: false,
  loader: async ({ context, params }) => {
    const overview = shownOverview(await context.walletClient.overview());

    if (!Predicate.isTagged(overview, "Holding"))
      return { overview, balance: undefined };

    const balance = overview.balances.find(
      (held) => assetKey(held.asset) === params.asset,
    );

    if (!balance) throw notFound();

    return { overview, balance };
  },
  component: SendAsset,
});

function SendAsset() {
  const { overview, balance } = Route.useLoaderData();
  const { transfer } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [locked, setLocked] = useState(false);

  return (
    <Screen>
      <TopNav
        title={balance ? `Enviar ${assetCode(balance.asset)}` : "Enviar"}
        label="Atrás"
        icon={<ChevronLeftIcon absoluteStrokeWidth />}
        link={<Link to="/send" />}
        disabled={locked}
      />
      {Match.valueTags(overview, {
        Holding: () =>
          balance ? (
            <SendFlow
              asset={balance.asset}
              available={balance.amount}
              transfer={Option.fromNullishOr(transfer)}
              onLock={setLocked}
              onTransfer={(id) => {
                if (Option.getOrUndefined(id) !== transfer)
                  void navigate({
                    search: { transfer: Option.getOrUndefined(id) },
                    replace: true,
                  });
              }}
            />
          ) : null,
        NeedsReopening: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        InvalidAddress: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        UnsupportedDevice: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        Offline: (unavailable) => <SendUnavailable overview={unavailable} />,
        ServerUnreachable: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        LedgerUnreachable: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        ServiceFailed: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        InvalidResponse: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
      })}
    </Screen>
  );
}
