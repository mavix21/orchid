import {
  type KeyObject,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  PasskeyAssertion,
  type PasskeyChallenge,
  PasskeyRegistration,
} from "../src/contract";
import { PasskeyCancelled, type Passkeys } from "../src/device/passkeys";

interface SoftwareCredential {
  readonly id: Buffer;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly prfSecret: Buffer;
  signCount: number;
}

const userPresentAndVerified = 0x05;
const attestedCredentialData = 0x40;

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest();

const counterBytes = (count: number) => {
  const bytes = Buffer.alloc(4);

  bytes.writeUInt32BE(count);

  return bytes;
};

const coseKey = (publicKey: KeyObject) => {
  const jwk = publicKey.export({ format: "jwk" });

  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
};

const noneAttestation = (authenticatorData: Buffer) =>
  Buffer.concat([
    Buffer.from([0xa3, 0x63]),
    Buffer.from("fmt"),
    Buffer.from([0x64]),
    Buffer.from("none"),
    Buffer.from([0x67]),
    Buffer.from("attStmt"),
    Buffer.from([0xa0, 0x68]),
    Buffer.from("authData"),
    Buffer.from([0x58, authenticatorData.length]),
    authenticatorData,
  ]);

export class SoftwareAuthenticator {
  readonly credentials: Array<SoftwareCredential> = [];
  prf = true;
  cancels = false;

  constructor(readonly origin: string) {}

  private clientData(type: string, challenge: PasskeyChallenge) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin }),
    );
  }

  private rpIdHash() {
    return sha256(new URL(this.origin).hostname);
  }

  private evaluate(credential: SoftwareCredential, salt: Uint8Array) {
    return Uint8Array.from(
      createHmac("sha256", credential.prfSecret).update(salt).digest(),
    );
  }

  forge(id: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });

    this.credentials.push({
      id: Buffer.from(id, "base64url"),
      privateKey,
      publicKey,
      prfSecret: randomBytes(32),
      signCount: 0,
    });
  }

  readonly passkeys: Passkeys = {
    register: (challenge, _username, salt) =>
      Effect.suspend(() => {
        if (this.cancels) return Effect.fail(new PasskeyCancelled());

        const { privateKey, publicKey } = generateKeyPairSync("ec", {
          namedCurve: "P-256",
        });

        const credential: SoftwareCredential = {
          id: randomBytes(16),
          privateKey,
          publicKey,
          prfSecret: randomBytes(32),
          signCount: 0,
        };

        this.credentials.push(credential);

        const idLength = Buffer.alloc(2);

        idLength.writeUInt16BE(credential.id.length);

        const authenticatorData = Buffer.concat([
          this.rpIdHash(),
          Buffer.from([userPresentAndVerified | attestedCredentialData]),
          counterBytes(credential.signCount),
          Buffer.alloc(16),
          idLength,
          credential.id,
          coseKey(publicKey),
        ]);

        if (!this.prf) return Effect.succeed(Option.none());

        return Effect.succeed(
          Option.some({
            prf: this.evaluate(credential, salt),
            registration: new PasskeyRegistration({
              id: credential.id.toString("base64url"),
              clientDataJSON: this.clientData(
                "webauthn.create",
                challenge,
              ).toString("base64url"),
              authenticatorData: authenticatorData.toString("base64url"),
              attestationObject:
                noneAttestation(authenticatorData).toString("base64url"),
              publicKey: publicKey
                .export({ type: "spki", format: "der" })
                .toString("base64url"),
              publicKeyAlgorithm: -7,
              transports: ["internal"],
            }),
          }),
        );
      }),
    authenticate: (challenge, salt) =>
      Effect.suspend(() => {
        if (this.cancels) return Effect.fail(new PasskeyCancelled());

        const credential = this.credentials.at(-1);

        if (credential === undefined || !this.prf)
          return Effect.succeed(Option.none());

        credential.signCount += 1;

        const clientDataJSON = this.clientData("webauthn.get", challenge);

        const authenticatorData = Buffer.concat([
          this.rpIdHash(),
          Buffer.from([userPresentAndVerified]),
          counterBytes(credential.signCount),
        ]);

        const signature = sign(
          "sha256",
          Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
          { key: credential.privateKey, dsaEncoding: "der" },
        );

        return Effect.succeed(
          Option.some({
            prf: this.evaluate(credential, salt),
            assertion: new PasskeyAssertion({
              id: credential.id.toString("base64url"),
              clientDataJSON: clientDataJSON.toString("base64url"),
              authenticatorData: authenticatorData.toString("base64url"),
              signature: signature.toString("base64url"),
            }),
          }),
        );
      }),
  };
}
