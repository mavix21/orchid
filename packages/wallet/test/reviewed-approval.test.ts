import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type Approval,
  type DestinationAddress,
  PositiveAmount,
  SigningRequest,
} from "../src/contract";
import type { AssertionCeremony } from "../src/device/assertion";
import { Reserved, approveReviewed } from "../src/device/reviewed-approval";
import { signingPayload } from "../src/stellar/envelopes";
import { nowSeconds, sendActors } from "./device-fixtures";
import { approvingDevice, installSealedWallet } from "./sealed-wallet-fixtures";

const actors = sendActors();
const amount = Schema.decodeSync(PositiveAmount)("10000000");

const requestTo = (to: DestinationAddress) =>
  new SigningRequest({
    envelope: actors.payment({ to, amount }),
    expiresAt: DateTime.makeUnsafe((nowSeconds() + 120) * 1000),
  });

it.live.each([
  {
    name: "signs every envelope from one assertion",
    laterLapses: false,
    withheld: undefined,
    verifiedSignatures: [true, true],
  },
  {
    name: "releases none when one envelope changes during the prompt",
    laterLapses: true,
    withheld: "DraftRejected",
    verifiedSignatures: [],
  },
])("$name", ({ laterLapses, withheld, verifiedSignatures }) =>
  Effect.gen(function* () {
    const { auth, record } = yield* installSealedWallet(actors.wallet);
    const first = requestTo(actors.pedro);
    const later = requestTo(actors.exchange);
    const released: Array<Approval> = [];
    let prompted = false;

    const ceremony: AssertionCeremony = {
      assert: (request) =>
        Effect.sync(() => {
          prompted = true;
        }).pipe(Effect.andThen(auth.assertions.assert(request))),
    };

    const outcome = yield* approveReviewed(
      { ...approvingDevice(auth), ceremony },
      {
        record,
        requests: [first, later],
        holds: (_wallet, request) =>
          Effect.sync(() => !(laterLapses && prompted && request === later)),
        reserve: (wallet) =>
          Effect.succeed(new Reserved({ reservation: wallet })),
        unreserve: () => Effect.void,
        release: (approvals) =>
          Effect.sync(() => {
            released.push(...approvals);
          }),
      },
    );

    expect(outcome?._tag).toBe(withheld);
    expect(
      released.map((approval, index) =>
        Keypair.fromPublicKey(actors.sender).verify(
          signingPayload(index === 0 ? first.envelope : later.envelope),
          Buffer.from(approval.signature),
        ),
      ),
    ).toEqual(verifiedSignatures);
  }),
);
