import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  PasskeyAssertion,
  PasskeyChallenge,
  PasskeyRegistration,
  Username,
} from "../contract";
import type { PrfInputs } from "./assertion";

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

export interface RegistrationRequest {
  readonly challenge: PasskeyChallenge;
  readonly username: Username;
  readonly prf: PrfInputs;
}

export interface PlatformRegistration {
  readonly registration: PasskeyRegistration;
  readonly prf: {
    readonly first: Option.Option<Uint8Array<ArrayBuffer>>;
    readonly second: Option.Option<Uint8Array<ArrayBuffer>>;
  };
}

export interface RegistrationCeremony {
  register(
    request: RegistrationRequest,
  ): Effect.Effect<
    Option.Option<PlatformRegistration>,
    PasskeyCancelled | PasskeyFailed
  >;
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
