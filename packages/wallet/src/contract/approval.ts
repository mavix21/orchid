import * as Schema from "effect/Schema";

/** A transaction the server built and nobody has signed. Opaque outside `stellar/`. */
export const UnsignedEnvelope = Schema.String.pipe(
  Schema.brand("UnsignedEnvelope"),
);

export type UnsignedEnvelope = typeof UnsignedEnvelope.Type;

export class SigningRequest extends Schema.Class<SigningRequest>(
  "@workspace/wallet/SigningRequest",
)({
  envelope: UnsignedEnvelope,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

/** Each signing stage returns one signature and no envelope. */
export class Approval extends Schema.Class<Approval>(
  "@workspace/wallet/Approval",
)({
  signature: Schema.Uint8ArrayFromBase64,
}) {}
