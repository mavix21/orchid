export interface AddressFormat {
  readonly isAccountAddress: (text: string) => boolean;
  readonly isDestinationAddress: (text: string) => boolean;
  readonly isLinkSecret: (text: string) => boolean;
  readonly forbidsMemo: (text: string) => boolean;
  readonly hasValidChecksum: (text: string) => boolean;
}
