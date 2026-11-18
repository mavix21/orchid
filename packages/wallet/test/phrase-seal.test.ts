import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SealedPhrase } from "../src/contract";
import { openPhrase, sealPhrase } from "../src/device/phrase-seal";
import { generateSecretPhrase } from "../src/device/secret-phrase";

const sealedByVersionOne = (prf: Buffer, phrase: string) => {
  const key = Buffer.from(
    hkdfSync("sha256", prf, Buffer.alloc(0), "orchid-secret-phrase-backup", 32),
  );

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  return new SealedPhrase({
    iv: Uint8Array.from(iv),
    ciphertext: Uint8Array.from(
      Buffer.concat([
        cipher.update(phrase),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    ),
  });
};

it.effect("opens a phrase sealed with the version 1 backup format", () =>
  Effect.gen(function* () {
    const prf = randomBytes(32);
    const phrase = generateSecretPhrase();

    expect(
      yield* openPhrase(Uint8Array.from(prf), sealedByVersionOne(prf, phrase)),
    ).toEqual(Option.some(phrase));
  }),
);

it.effect("a different passkey output cannot open a sealed phrase", () =>
  Effect.gen(function* () {
    const phrase = generateSecretPhrase();
    const sealed = yield* sealPhrase(Uint8Array.from(randomBytes(32)), phrase);

    expect(yield* openPhrase(Uint8Array.from(randomBytes(32)), sealed)).toEqual(
      Option.none(),
    );
  }),
);
