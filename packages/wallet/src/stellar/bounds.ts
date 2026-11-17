import * as Schema from "effect/Schema";

/** What every drafted transaction pins: its sequence number and time bounds. */
export const bounds = {
  sequence: Schema.String,
  minTime: Schema.Number,
  maxTime: Schema.Number,
};
