import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  PasskeyAssertion,
  PasskeyChallenge,
  PasskeyRegistration,
  Username,
} from "../contract";

export class PasskeyCancelled extends Schema.TaggedError<PasskeyCancelled>()(
  "PasskeyCancelled",
  {},
) {}

export class PasskeyFailed extends Schema.TaggedError<PasskeyFailed>()(
  "PasskeyFailed",
  {},
) {}

export interface RegisteredPasskey {
  readonly registration: PasskeyRegistration;
  readonly prf: Uint8Array<ArrayBuffer>;
}

export interface AuthenticatedPasskey {
  readonly assertion: PasskeyAssertion;
  readonly prf: Uint8Array<ArrayBuffer>;
}

export interface Passkeys {
  register(
    challenge: PasskeyChallenge,
    username: Username,
    salt: Uint8Array<ArrayBuffer>,
  ): Effect.Effect<
    Option.Option<RegisteredPasskey>,
    PasskeyCancelled | PasskeyFailed
  >;
  authenticate(
    challenge: PasskeyChallenge,
    salt: Uint8Array<ArrayBuffer>,
  ): Effect.Effect<
    Option.Option<AuthenticatedPasskey>,
    PasskeyCancelled | PasskeyFailed
  >;
}
