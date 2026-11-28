import * as Context from "effect/Context";

export class UserInputs extends Context.Service<
  UserInputs,
  { readonly answers: ReadonlyArray<string> }
>()("@web/agent/UserInputs") {}
