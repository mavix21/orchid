import { expect, it } from "@effect/vitest";
import { Account, MuxedAccount } from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import { type AddressNetwork, recogniseAddress } from "../src/contract";

const stellarAccount =
  "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

const stellarMuxed = new MuxedAccount(
  new Account(stellarAccount, "0"),
  "1",
).accountId();

const lastCharacterAltered = (address: string) =>
  address.slice(0, -1) + (address.endsWith("q") ? "p" : "q");

it.each<{ name: string; address: string; network: AddressNetwork }>([
  { name: "Stellar account", address: stellarAccount, network: "stellar" },
  { name: "Stellar muxed account", address: stellarMuxed, network: "stellar" },
  {
    name: "EVM lowercase",
    address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    network: "evm",
  },
  {
    name: "EVM checksummed",
    address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    network: "evm",
  },
  {
    name: "Solana",
    address: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
    network: "solana",
  },
  {
    name: "Tron",
    address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    network: "tron",
  },
  {
    name: "Bitcoin pay-to-pubkey-hash",
    address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    network: "bitcoin",
  },
  {
    name: "Bitcoin pay-to-script-hash",
    address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    network: "bitcoin",
  },
  {
    name: "Bitcoin native segwit",
    address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    network: "bitcoin",
  },
  {
    name: "Bitcoin taproot",
    address: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    network: "bitcoin",
  },
])("recognises a $name address", ({ address, network }) => {
  expect(recogniseAddress(address)).toEqual(Option.some(network));
});

it.each<{ name: string; address: string }>([
  { name: "Stellar account", address: lastCharacterAltered(stellarAccount) },
  { name: "Stellar muxed", address: lastCharacterAltered(stellarMuxed) },
  {
    name: "EVM mixed-case with a wrong capital",
    address: "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  },
  {
    name: "EVM with a short body",
    address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae",
  },
  {
    name: "Solana off the curve",
    address: "11111111111111111111111111111112",
  },
  {
    name: "Solana of the wrong length",
    address: "GmaDrppBC7P5ARKV8g3djiwP89vz1j",
  },
  {
    name: "Tron with a bad checksum",
    address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u",
  },
  {
    name: "Bitcoin with a bad checksum",
    address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",
  },
  {
    name: "Bitcoin segwit with a bad checksum",
    address: lastCharacterAltered("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"),
  },
  {
    name: "Bitcoin segwit of another network",
    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  },
  { name: "empty text", address: "" },
])("rejects $name", ({ address }) => {
  expect(recogniseAddress(address)).toEqual(Option.none());
});
