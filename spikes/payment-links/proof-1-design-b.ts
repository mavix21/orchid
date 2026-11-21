import { Keypair, Memo } from "@stellar/stellar-sdk";
import {
  cancelB,
  claimB,
  createB,
  freezeAccount,
  mergeOp,
  removeRosa,
} from "./lib/design-b";
import { emit } from "./lib/report";
import {
  accountFacts,
  execute,
  exists,
  lineFacts,
  memoFacts,
  sponsorCounters,
} from "./lib/steps";
import { build, bump, openWallet, openWorld } from "./lib/world";
import { Operation } from "@stellar/stellar-sdk";

const proof = "1";
const amount = "25";

const world = await openWorld(0);

emit(proof, "world", undefined, {
  sponsor: world.sponsor.publicKey(),
  feePayer: world.feePayer.publicKey(),
  rosa: world.rosa.publicKey(),
  issuer: world.issuer.publicKey(),
});

await sponsorCounters(proof, "baseline", world);

const externalClaim = Keypair.random();
const exchange = await openWallet(world);

await execute(
  proof,
  "B create (claim to external G with memo)",
  await createB(world, externalClaim, amount),
  {
    link: externalClaim.publicKey(),
  },
);

await accountFacts(proof, "after B create", externalClaim.publicKey());

await sponsorCounters(proof, "after B create", world);

const claimed = await execute(
  proof,
  "B claim to external G with MEMO_TEXT 12345",
  await claimB(
    world,
    externalClaim,
    exchange.publicKey(),
    amount,
    Memo.text("12345"),
  ),
);

await memoFacts(proof, "B claim", claimed.hash);

await lineFacts(
  proof,
  "external destination after claim",
  exchange.publicKey(),
  world.usdc,
);

emit(proof, "link account removed after claim", undefined, {
  exists: await exists(externalClaim.publicKey()),
});

await sponsorCounters(proof, "after B claim", world);

const walletClaim = Keypair.random();
const wallet = await openWallet(world);

await execute(
  proof,
  "B create (claim into wallet-shaped destination)",
  await createB(world, walletClaim, amount),
);

await execute(
  proof,
  "B claim into wallet-shaped destination, no memo",
  await claimB(world, walletClaim, wallet.publicKey(), amount),
);

await lineFacts(
  proof,
  "wallet-shaped destination after claim",
  wallet.publicKey(),
  world.usdc,
);

await sponsorCounters(proof, "after B wallet claim", world);

const cancelled = Keypair.random();

await execute(
  proof,
  "B create (cancel by sender)",
  await createB(world, cancelled, amount),
);

await sponsorCounters(proof, "after B create for cancel", world);

await execute(
  proof,
  "B cancel signed only by the sender key",
  await cancelB(world, cancelled.publicKey(), amount, [world.rosa]),
);

emit(proof, "link account removed after cancel", undefined, {
  exists: await exists(cancelled.publicKey()),
});

await lineFacts(
  proof,
  "sender after cancel",
  world.rosa.publicKey(),
  world.usdc,
);

await sponsorCounters(proof, "after B cancel", world);

const stripped = Keypair.random();

await execute(
  proof,
  "plain B create (signer removal demonstration)",
  await createB(world, stripped, amount),
);

await execute(
  proof,
  "plain B bearer removes the sender signer using only L",
  await removeRosa(world, stripped),
);

await accountFacts(proof, "plain B after signer removal", stripped.publicKey());

await execute(
  proof,
  "plain B sender cancel after removal",
  await cancelB(world, stripped.publicKey(), amount, [world.rosa]),
);

await lineFacts(
  proof,
  "plain B link line after failed cancel",
  stripped.publicKey(),
  world.usdc,
);

const hardened = Keypair.random();

await execute(
  proof,
  "hardened B create",
  await createB(world, hardened, amount, "hardened"),
);

await accountFacts(proof, "hardened B after create", hardened.publicKey());

await sponsorCounters(proof, "after hardened B create", world);

await execute(
  proof,
  "hardened B bearer attempts signer removal with L alone",
  await removeRosa(world, hardened),
);

await execute(
  proof,
  "hardened B bearer sets AUTH_IMMUTABLE with L alone",
  await freezeAccount(world, hardened),
);

await execute(
  proof,
  "hardened B bearer claim with merge signed by L alone",
  await claimB(world, hardened, exchange.publicKey(), amount),
);

await execute(
  proof,
  "hardened B sender refund payment-only, signed by sender",
  await cancelB(world, hardened.publicKey(), amount, [world.rosa], false),
);

await accountFacts(
  proof,
  "hardened B after payment-only refund",
  hardened.publicKey(),
);

await sponsorCounters(proof, "after hardened B payment-only refund", world);

const merge = await build(
  world.rosa.publicKey(),
  [mergeOp(world, hardened.publicKey())],
  [world.rosa, world.sponsor],
);

await execute(
  proof,
  "hardened B plain merge attempt signed by sender and sponsor",
  bump(world.feePayer, merge),
);

const release = await build(
  world.rosa.publicKey(),
  [
    Operation.setOptions({
      signer: { ed25519PublicKey: world.rosa.publicKey(), weight: 0 },
      source: hardened.publicKey(),
    }),
    Operation.setOptions({
      signer: { ed25519PublicKey: world.sponsor.publicKey(), weight: 0 },
      source: hardened.publicKey(),
    }),
  ],
  [world.rosa, world.sponsor],
);

await execute(
  proof,
  "hardened B remove sender and sponsor signers",
  bump(world.feePayer, release),
);

await accountFacts(proof, "hardened B final residue", hardened.publicKey());

await sponsorCounters(proof, "after hardened B residue", world);
