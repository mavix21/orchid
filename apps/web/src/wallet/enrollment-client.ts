import {
  type PendingEnrollmentStorage,
  PendingReopenCandidate,
  type SealedKeyStore,
  browserAssertions,
  browserKeyStore,
  browserRegistration,
  browserRelyingParty,
  makeEnrollmentEffects,
} from "@workspace/wallet";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { port } from "./port.functions";
import { markWalletOnDevice } from "./wallet-cookie";

const pendingStorageKey = "orchid-pending-enrollment";

const pendingCandidateJson = Schema.fromJsonString(PendingReopenCandidate);
const decodePending = Schema.decodeUnknownOption(pendingCandidateJson);
const encodePending = Schema.encodeSync(pendingCandidateJson);

const sessionPendingEnrollment: PendingEnrollmentStorage = {
  read: () =>
    Effect.sync(() => {
      try {
        const raw = sessionStorage.getItem(pendingStorageKey);

        if (raw === null) return Option.none();

        const decoded = decodePending(raw);

        if (Option.isNone(decoded))
          sessionStorage.removeItem(pendingStorageKey);

        return decoded;
      } catch {
        return Option.none();
      }
    }),
  write: (candidate) =>
    Effect.sync(() => {
      try {
        sessionStorage.setItem(pendingStorageKey, encodePending(candidate));
      } catch {}
    }),
  clear: () =>
    Effect.sync(() => {
      try {
        sessionStorage.removeItem(pendingStorageKey);
      } catch {}
    }),
};

const webSealedKeyStore: SealedKeyStore = {
  readPublic: () =>
    browserKeyStore
      .readPublic()
      .pipe(
        Effect.tap((stored) =>
          Effect.sync(() => markWalletOnDevice(Option.isSome(stored))),
        ),
      ),
  updatePublic: (update) =>
    browserKeyStore.updatePublic(update).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (Option.isSome(result)) markWalletOnDevice(true);
        }),
      ),
    ),
  readSealed: () => browserKeyStore.readSealed(),
  writeSealed: (wallet) =>
    browserKeyStore
      .writeSealed(wallet)
      .pipe(Effect.tap(() => Effect.sync(() => markWalletOnDevice(true)))),
};

export const enrollmentEffects = makeEnrollmentEffects({
  port,
  store: webSealedKeyStore,
  registration: browserRegistration,
  assertions: browserAssertions,
  relyingParty: browserRelyingParty(),
  pending: sessionPendingEnrollment,
});
