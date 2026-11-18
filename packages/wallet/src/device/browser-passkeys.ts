import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type PasskeyChallenge,
  PasskeyAssertion,
  PasskeyRegistration,
  PasskeyTransport,
  type Username,
} from "../contract";
import { PasskeyCancelled, type Passkeys } from "./passkeys";

const toBase64Url = (buffer: ArrayBuffer) =>
  Schema.encodeSync(Schema.Uint8ArrayFromBase64Url)(new Uint8Array(buffer));

const challengeBytes = (challenge: PasskeyChallenge) =>
  Uint8Array.from(Schema.decodeSync(Schema.Uint8ArrayFromBase64Url)(challenge));

const verifiableAlgorithms: Array<PublicKeyCredentialParameters> = [
  { type: "public-key", alg: -7 },
  { type: "public-key", alg: -257 },
];

class PasskeyUnavailable extends Schema.TaggedError<PasskeyUnavailable>()(
  "PasskeyUnavailable",
  {},
) {}

const ceremony = (run: () => Promise<Credential | null>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof DOMException &&
      (cause.name === "NotAllowedError" || cause.name === "AbortError")
        ? new PasskeyCancelled()
        : new PasskeyUnavailable(),
  }).pipe(
    Effect.flatMap((credential) =>
      credential instanceof PublicKeyCredential
        ? Effect.succeed(credential)
        : Effect.fail(new PasskeyUnavailable()),
    ),
  );

const prfReported = Effect.tryPromise(async () =>
  "getClientCapabilities" in PublicKeyCredential
    ? (await PublicKeyCredential.getClientCapabilities())["extension:prf"] !==
      false
    : true,
).pipe(Effect.orElseSucceed(() => true));

const withoutPasskey = <A>(
  ceremonyResult: Effect.Effect<
    Option.Option<A>,
    PasskeyCancelled | PasskeyUnavailable
  >,
) =>
  ceremonyResult.pipe(
    Effect.catchTag("PasskeyUnavailable", () =>
      Effect.succeed(Option.none<A>()),
    ),
  );

const prfOutput = (credential: PublicKeyCredential) => {
  const first = credential.getClientExtensionResults().prf?.results?.first;

  if (first === undefined) return Option.none<Uint8Array<ArrayBuffer>>();

  return Option.some(
    first instanceof ArrayBuffer
      ? Uint8Array.from(new Uint8Array(first))
      : Uint8Array.from(
          new Uint8Array(first.buffer, first.byteOffset, first.byteLength),
        ),
  );
};

const prfRequest = (salt: Uint8Array<ArrayBuffer>) => ({
  prf: { eval: { first: salt } },
});

const webAuthnAvailable = () =>
  "PublicKeyCredential" in globalThis && "credentials" in navigator;

const assertPrf = (credentialId: ArrayBuffer, salt: Uint8Array<ArrayBuffer>) =>
  ceremony(() =>
    navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: credentialId }],
        userVerification: "required",
        extensions: prfRequest(salt),
      },
    }),
  ).pipe(Effect.map(prfOutput));

const register = Effect.fn("Device.registerPasskey")(function* (
  challenge: PasskeyChallenge,
  username: Username,
  salt: Uint8Array<ArrayBuffer>,
) {
  if (!webAuthnAvailable() || !(yield* prfReported)) return Option.none();

  const created = yield* ceremony(() =>
    navigator.credentials.create({
      publicKey: {
        challenge: challengeBytes(challenge),
        rp: { name: "Orchid", id: location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: `@${username}`,
          displayName: `@${username}`,
        },
        pubKeyCredParams: verifiableAlgorithms,
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        extensions: prfRequest(salt),
      },
    }),
  );

  const response = created.response;

  const publicKey =
    response instanceof AuthenticatorAttestationResponse
      ? response.getPublicKey()
      : null;

  if (
    !(response instanceof AuthenticatorAttestationResponse) ||
    publicKey === null ||
    created.getClientExtensionResults().prf?.enabled !== true
  )
    return Option.none();

  const createdPrf = prfOutput(created);

  const prf = Option.isSome(createdPrf)
    ? createdPrf
    : yield* assertPrf(created.rawId, salt);

  if (Option.isNone(prf)) return Option.none();

  return Option.some({
    prf: prf.value,
    registration: new PasskeyRegistration({
      id: created.id,
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.getAuthenticatorData()),
      attestationObject: toBase64Url(response.attestationObject),
      publicKey: toBase64Url(publicKey),
      publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
      transports: response
        .getTransports()
        .flatMap((transport) =>
          Option.toArray(
            Schema.decodeUnknownOption(PasskeyTransport)(transport),
          ),
        ),
    }),
  });
}, withoutPasskey);

const authenticate = Effect.fn("Device.authenticatePasskey")(function* (
  challenge: PasskeyChallenge,
  salt: Uint8Array<ArrayBuffer>,
) {
  if (!webAuthnAvailable()) return Option.none();

  const asserted = yield* ceremony(() =>
    navigator.credentials.get({
      publicKey: {
        challenge: challengeBytes(challenge),
        rpId: location.hostname,
        userVerification: "required",
        extensions: prfRequest(salt),
      },
    }),
  );

  const response = asserted.response;
  const prf = prfOutput(asserted);

  if (
    !(response instanceof AuthenticatorAssertionResponse) ||
    Option.isNone(prf)
  )
    return Option.none();

  return Option.some({
    prf: prf.value,
    assertion: new PasskeyAssertion({
      id: asserted.id,
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
    }),
  });
}, withoutPasskey);

export const browserPasskeys: Passkeys = { register, authenticate };
