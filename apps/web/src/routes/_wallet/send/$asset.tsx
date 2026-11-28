import { ChevronLeftIcon } from "lucide-react";
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from "@tanstack/react-router";
import { TransferId } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { Screen } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { SendFlow, type SendPrefill } from "@/send/send-flow";
import {
  SendUnavailable,
  type UnavailableOverview,
} from "@/send/send-unavailable";
import { shownOverview } from "@/wallet/shown-overview";
import { m } from "@/paraglide/messages";

const TransferSearch = Schema.Struct({
  transfer: Schema.optional(TransferId),
  to: Schema.optional(Schema.Literals(["username", "address", "link"])),
  recipient: Schema.optional(Schema.String),
  amount: Schema.optional(Schema.String),
  memo: Schema.optional(Schema.String),
  save: Schema.optional(Schema.Boolean),
});

const prefillOf = ({
  to,
  recipient = "",
  amount = "",
  memo = "",
  save = true,
}: typeof TransferSearch.Type): Option.Option<SendPrefill> =>
  Match.value(to).pipe(
    Match.withReturnType<Option.Option<SendPrefill>>(),
    Match.when("link", () =>
      Option.some({ destination: "link", amount, saveOnDevice: save }),
    ),
    Match.when("username", () =>
      Option.some({
        destination: "username",
        form: { recipient, amount, memo },
      }),
    ),
    Match.when("address", () =>
      Option.some({
        destination: "address",
        form: { recipient, amount, memo },
      }),
    ),
    Match.orElse(() => Option.none()),
  );

export const Route = createFileRoute("/_wallet/send/$asset")({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(TransferSearch),
  shouldReload: false,
  loader: async ({ context, params }) => {
    const overview = shownOverview(await context.walletClient.overview());

    if (!Predicate.isTagged(overview, "Holding"))
      return { overview, balance: undefined };

    const balance = overview.balances.find(
      (held) => held.asset.id === params.asset,
    );

    if (!balance) throw notFound();

    return { overview, balance };
  },
  component: SendAsset,
});

function SendAsset() {
  const { overview, balance } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const nav = (locked: boolean, edit?: () => void) => (
    <TopNav
      title={
        balance ? m.send_title({ asset: balance.asset.code }) : m.common_send()
      }
      label={m.common_back()}
      icon={<ChevronLeftIcon absoluteStrokeWidth />}
      link={
        <Link
          to="/send"
          onClick={(event) => {
            if (edit === undefined) return;

            event.preventDefault();
            edit();
          }}
        />
      }
      disabled={locked}
    />
  );

  const unavailable = (shown: UnavailableOverview) => (
    <>
      {nav(false)}
      <SendUnavailable overview={shown} />
    </>
  );

  return (
    <Screen>
      {Match.valueTags(overview, {
        Holding: () =>
          balance ? (
            <SendFlow
              asset={balance.asset}
              available={balance.amount}
              transfer={Option.fromNullishOr(search.transfer)}
              prefill={prefillOf(search)}
              nav={nav}
              onTransfer={(id) =>
                void navigate({
                  search: { transfer: Option.getOrUndefined(id) },
                  replace: true,
                })
              }
            />
          ) : (
            nav(false)
          ),
        NeedsReopening: unavailable,
        InvalidAddress: unavailable,
        UnsupportedDevice: unavailable,
        Offline: unavailable,
        ServerUnreachable: unavailable,
        LedgerUnreachable: unavailable,
        ServiceFailed: unavailable,
        SessionRequired: unavailable,
        RateLimited: unavailable,
        InvalidResponse: unavailable,
      })}
    </Screen>
  );
}
