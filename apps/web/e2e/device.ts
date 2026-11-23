import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { type Page, expect } from "@playwright/test";
import {
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  AccountAddress,
  CredentialId,
  LocalPhraseEnvelope,
  PinnedCredential,
  PublicDeviceWallet,
  SealedDeviceWallet,
  Username,
  localEnvelopeVersion,
} from "@workspace/wallet";
import { fundWithFriendbot, horizon, usdc } from "@workspace/wallet/testnet";
import * as Schema from "effect/Schema";

export const addAuthenticator = async (page: Page, hasPrf: boolean) => {
  const session = await page.context().newCDPSession(page);

  await session.send("WebAuthn.enable");

  const { authenticatorId } = await session.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf,
        automaticPresenceSimulation: true,
      },
    },
  );

  return {
    session,
    authenticatorId,
    verifyUser: (isUserVerified: boolean) =>
      session.send("WebAuthn.setUserVerified", {
        authenticatorId,
        isUserVerified,
      }),
  };
};

const addSeededCredential = async (page: Page) => {
  const authenticator = await addAuthenticator(page, false);

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  const id = randomBytes(16);

  await authenticator.session.send("WebAuthn.addCredential", {
    authenticatorId: authenticator.authenticatorId,
    credential: {
      credentialId: id.toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
      userHandle: randomBytes(16).toString("base64"),
      signCount: 0,
    },
  });

  return {
    authenticator,
    id: id.toString("base64url"),
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  };
};

export const countPasskeyPrompts = async (page: Page) => {
  await page.addInitScript(() => {
    const record = (kind: "create" | "get") =>
      sessionStorage.setItem(
        `prompts-${kind}`,
        String(Number(sessionStorage.getItem(`prompts-${kind}`) ?? 0) + 1),
      );

    const credentials = navigator.credentials;
    const create = credentials.create.bind(credentials);
    const get = credentials.get.bind(credentials);

    credentials.create = (options) => {
      record("create");

      return create(options);
    };

    credentials.get = (options) => {
      record("get");

      return get(options);
    };
  });

  return () =>
    page.evaluate(() => ({
      create: Number(sessionStorage.getItem("prompts-create") ?? 0),
      get: Number(sessionStorage.getItem("prompts-get") ?? 0),
    }));
};

export const freshUsername = () =>
  `e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export const usernameInput = (page: Page) => page.getByRole("textbox");

export const submitButton = (page: Page) => page.getByTestId("create-submit");

export const serverFunction = "/_serverFn/";

const e2eContainer = "orchid-e2e-database";
const testnetReset = Date.UTC(2026, 11, 16);

export const markWalletRecovered = (address: AccountAddress) => {
  const sql = `
    UPDATE wallets SET
      status = 'recovered',
      "attemptEnvelope" = NULL, "attemptHash" = NULL, "attemptExpiresAt" = NULL,
      "recoveryDraft" = NULL, "recoveryEnvelope" = NULL, "recoveryHash" = NULL,
      "recoverySequence" = NULL, "recoveryMinTime" = NULL, "recoveryMaxTime" = NULL,
      "pairedRecoveryDraft" = NULL, "pairedRecoveryEnvelope" = NULL, "pairedRecoveryHash" = NULL
    WHERE address = '${address}';
  `;

  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      e2eContainer,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "orchid",
      "-d",
      "orchid",
    ],
    { input: sql, encoding: "utf8" },
  );

  if (result.status !== 0)
    throw new Error(
      `Failed to mark wallet recovered: ${result.stderr || result.stdout}`,
    );
};

export const storedWalletAddress = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open("orchid-device", 1);

        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const tx = request.result.transaction("entries", "readonly");
          const get = tx.objectStore("entries").get("wallet");

          get.addEventListener("error", () => reject(get.error));
          tx.addEventListener("complete", () => {
            request.result.close();
            resolve(get.result.public.address);
          });
        });
      }),
  );

const seedActiveWalletRow = (address: AccountAddress, username: Username) => {
  const epoch = Date.now() < testnetReset ? "before-2026-12-16" : "2026-12-16";

  const sql = `
    INSERT INTO wallets (
      address, status, network, "testnetEpoch",
      "recoveryEnvelope", "recoveryHash", "recoverySequence",
      "recoveryMinTime", "recoveryMaxTime"
    ) VALUES (
      '${address}', 'active', 'testnet', '${epoch}',
      'seeded', 'seeded', '1', NOW(), NOW() + INTERVAL '7 days'
    );
    INSERT INTO usernames (username, address) VALUES ('${username}', '${address}');
  `;

  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      e2eContainer,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "orchid",
      "-d",
      "orchid",
    ],
    { input: sql, encoding: "utf8" },
  );

  if (result.status !== 0)
    throw new Error(
      `Failed to seed open wallet row: ${result.stderr || result.stdout}`,
    );
};

interface SeededCredential {
  readonly id: string;
  readonly publicKey: string;
}

const seededRecord = (
  address: AccountAddress,
  username: Username,
  seeded: SeededCredential,
) => {
  const credentialId = Schema.decodeSync(CredentialId)(seeded.id);

  return Schema.encodeSync(SealedDeviceWallet)(
    new SealedDeviceWallet({
      version: localEnvelopeVersion,
      public: new PublicDeviceWallet({
        address,
        username,
        backup: "stored",
      }),
      credential: new PinnedCredential({
        id: credentialId,
        publicKey: seeded.publicKey,
        algorithm: "ES256",
      }),
      envelope: new LocalPhraseEnvelope({
        version: localEnvelopeVersion,
        network: "testnet",
        address,
        credentialId,
        salt: new Uint8Array(32).fill(1),
        iv: new Uint8Array(12).fill(2),
        ciphertext: new Uint8Array(32).fill(3),
      }),
    }),
  );
};

export const storedWalletRecord = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open("orchid-device", 1);

        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains("entries"))
            request.result.createObjectStore("entries");
        });
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const tx = request.result.transaction("entries", "readonly");
          const get = tx.objectStore("entries").get("wallet");

          get.addEventListener("error", () => reject(get.error));
          tx.addEventListener("complete", () => {
            request.result.close();
            resolve(get.result !== undefined);
          });
        });
      }),
  );

const fundAccountWithUsdcTrustline = async (keypair: Keypair) => {
  const account = await fundWithFriendbot(keypair.publicKey());

  const trustline = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(60)
    .build();

  trustline.sign(keypair);
  await horizon.submitTransaction(trustline);
};

export const seedWallet = async (page: Page, usernameText: string) => {
  const keypair = Keypair.random();
  const address = Schema.decodeSync(AccountAddress)(keypair.publicKey());
  const username = Schema.decodeSync(Username)(usernameText);

  await fundAccountWithUsdcTrustline(keypair);
  seedActiveWalletRow(address, username);

  const credential = await addSeededCredential(page);
  const record = seededRecord(address, username, credential);

  await page.goto("/");
  await page.evaluate(
    (encoded) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("orchid-device", 1);

        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains("entries"))
            request.result.createObjectStore("entries");
        });
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const tx = request.result.transaction("entries", "readwrite");

          tx.objectStore("entries").put(encoded, "wallet");
          tx.addEventListener("error", () => reject(tx.error));
          tx.addEventListener("complete", () => {
            request.result.close();
            document.cookie = "orchid-wallet=1; path=/; samesite=lax";
            resolve();
          });
        });
      }),
    record,
  );

  return { address, verifyUser: credential.authenticator.verifyUser };
};

export const unlockButton = (page: Page) => page.getByTestId("unlock-wallet");

export const unlockWallet = async (page: Page) => {
  await unlockButton(page).click();
  await expect(unlockButton(page)).toBeHidden({ timeout: 30_000 });
};

export const visit = async (page: Page, path: string) => {
  await page.goto(path);
  await unlockWallet(page);
};

export const reloadUnlocked = async (page: Page) => {
  await page.reload();
  await unlockWallet(page);
};

export const openWallet = async (page: Page, usernameText: string) => {
  const { address } = await seedWallet(page, usernameText);

  await visit(page, "/home");
  await expect(page).toHaveURL("/home", { timeout: 60_000 });

  return address;
};
