// Local mock data for the first screens; no backend is involved yet.
export type AvatarTone = "orchid" | "lila" | "rosa" | "durazno";

export type Profile = {
  username: string;
  tone: AvatarTone;
  petals: ReadonlyArray<string>;
};
