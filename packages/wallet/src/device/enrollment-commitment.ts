import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Approvals, BackupEnrollment } from "../contract";
import { PendingCandidate } from "./enrollment-records";
import { OpeningReview } from "./outcomes";
import { type SecretPhrase } from "./secret-phrase";
import { signPayloadWithPhrase } from "./signing";

export class ReleaseContents extends Schema.Class<ReleaseContents>(
  "@workspace/wallet/ReleaseContents",
)({
  enrollment: BackupEnrollment,
  candidate: PendingCandidate,
  review: OpeningReview,
  approvals: Approvals,
}) {}

const releasePayload = (contents: ReleaseContents) =>
  new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(ReleaseContents))(contents),
  );

export const commitToRelease = (
  phrase: SecretPhrase,
  contents: ReleaseContents,
): Uint8Array<ArrayBuffer> =>
  signPayloadWithPhrase(phrase, releasePayload(contents));

export const commitmentHolds = (
  contents: ReleaseContents,
  commitment: Uint8Array,
) =>
  Effect.try(
    () =>
      commitment.byteLength === 64 &&
      Keypair.fromPublicKey(contents.candidate.address).verify(
        releasePayload(contents),
        commitment,
      ),
  ).pipe(Effect.orElseSucceed(() => false));
