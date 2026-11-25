import { XIcon } from "lucide-react";
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type { DeviceOverview, Profile } from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { OrchidPending } from "@/components/orchid-pending";
import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { DepositAddress } from "@/receive/deposit-address";
import { type OpeningCopy, OpeningFlow } from "@/wallet/opening-flow";
import { UnavailableNotice, unavailableNotice } from "@/wallet/unavailable";

const preparing = "Preparando tu dirección…";

const depositCopy: OpeningCopy = {
  preparing,
  confirming: preparing,
  title: "Abre tu cuenta",
  explanation:
    "Tu cuenta todavía no está abierta en la red Stellar. Confirma con tu passkey para abrirla y ver tu dirección.",
  action: "Abrir con passkey",
};

class Unopened extends Data.TaggedClass("Unopened")<{
  readonly profile: Profile;
}> {}

const shownReceive = (overview: DeviceOverview) =>
  Match.value(overview).pipe(
    Match.tag("NoWallet", () => {
      throw redirect({ to: "/", replace: true });
    }),
    Match.tag("NotOpened", ({ profile }) =>
      Option.match(profile, {
        onNone: () => {
          throw redirect({ to: "/create-account", replace: true });
        },
        onSome: (owner) => new Unopened({ profile: owner }),
      }),
    ),
    Match.orElse((shown) => shown),
  );

export const Route = createFileRoute("/_wallet/receive")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: () => (
    <ReceiveFrame>
      <OrchidPending title={preparing} />
    </ReceiveFrame>
  ),
  loader: async ({ context }) =>
    shownReceive(await context.walletClient.overview()),
  component: Receive,
});

function ReceiveFrame({ children }: { children: React.ReactNode }) {
  return (
    <Screen>
      <TopNav
        title="Recibir USDC"
        label="Cerrar"
        icon={<XIcon absoluteStrokeWidth />}
        link={<Link to="/home" />}
      />
      {children}
    </Screen>
  );
}

function Receive() {
  const router = useRouter();
  const shown = Route.useLoaderData();

  const opening = (username: string) => (
    <OpeningFlow
      username={username}
      copy={depositCopy}
      onOpened={() => void router.invalidate()}
    />
  );

  return (
    <ReceiveFrame>
      {Match.valueTags(shown, {
        Holding: ({ profile }) => <DepositAddress address={profile.address} />,
        Unopened: ({ profile }) => opening(profile.username),
        NeedsReopening: ({ profile }) => opening(profile.username),
        InvalidAddress: () => (
          <ReceiveUnavailable
            notice={
              new UnavailableNotice(
                "La llave guardada en este dispositivo no es válida.",
                false,
              )
            }
          />
        ),
        UnsupportedDevice: () => (
          <ReceiveUnavailable
            notice={
              new UnavailableNotice(
                "Este navegador no puede leer tu llave de forma segura.",
                false,
              )
            }
          />
        ),
        Offline: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
        ServerUnreachable: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
        LedgerUnreachable: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
        ServiceFailed: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
        SessionRequired: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
        RateLimited: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
        InvalidResponse: (failure) => (
          <ReceiveUnavailable notice={unavailableNotice(failure)} />
        ),
      })}
    </ReceiveFrame>
  );
}

function ReceiveUnavailable({ notice }: { notice: UnavailableNotice }) {
  const router = useRouter();

  return (
    <>
      <ScreenStatus title="No pudimos mostrar tu dirección">
        <ScreenNote>{notice.message}</ScreenNote>
      </ScreenStatus>
      {notice.actionable ? (
        <ScreenActions>
          <Button className="w-full" onClick={() => void router.invalidate()}>
            Reintentar
          </Button>
        </ScreenActions>
      ) : null}
    </>
  );
}
