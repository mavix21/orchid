export type AssetId = "usdc" | "xlm" | "eurc";

export type Asset = {
  id: AssetId;
  code: string;
  amount: string;
  localEquivalent: string;
};

export const assets: ReadonlyArray<Asset> = [
  {
    id: "usdc",
    code: "USDC",
    amount: "124.50",
    localEquivalent: "≈ S/ 466.90",
  },
  { id: "xlm", code: "XLM", amount: "320.00", localEquivalent: "≈ S/ 146.20" },
  { id: "eurc", code: "EURC", amount: "40.00", localEquivalent: "≈ S/ 161.10" },
];

export function findAsset(id: string) {
  return assets.find((asset) => asset.id === id);
}
