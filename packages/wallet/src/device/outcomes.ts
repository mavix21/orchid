import * as Schema from "effect/Schema";
import {
  type AddressBound,
  type Holding,
  type InvalidAddress,
  type NeedsReopening,
  type NotOpened,
  type NotSponsored,
  type Opened,
  type OpeningPending,
  Username,
  type UsernameTaken,
} from "../contract";

export class NoWallet extends Schema.TaggedClass<NoWallet>()("NoWallet", {}) {}

export class SavedWallet extends Schema.TaggedClass<SavedWallet>()(
  "SavedWallet",
  { username: Username, openingApproved: Schema.Boolean },
) {}

export type SavedOutcome = SavedWallet | NoWallet | UnsupportedDevice;

export class Offline extends Schema.TaggedClass<Offline>()("Offline", {}) {}

export class InvalidUsername extends Schema.TaggedClass<InvalidUsername>()(
  "InvalidUsername",
  {},
) {}

export class UnsupportedDevice extends Schema.TaggedClass<UnsupportedDevice>()(
  "UnsupportedDevice",
  {},
) {}

export class DraftRejected extends Schema.TaggedClass<DraftRejected>()(
  "DraftRejected",
  {},
) {}

export type DeviceOverview =
  | Holding
  | NeedsReopening
  | NotOpened
  | InvalidAddress
  | NoWallet
  | UnsupportedDevice
  | Offline;

export type CreateOutcome =
  | InvalidAddress
  | NotSponsored
  | Opened
  | OpeningPending
  | UsernameTaken
  | AddressBound
  | InvalidUsername
  | UnsupportedDevice
  | DraftRejected
  | Offline;
