/** The runtime exports every runner's smoke test checks for. */
export const PUBLIC_FUNCTIONS = [
  "fork",
  "expectRevert",
  "expectEmit",
  "expectBalanceChange",
  "label",
  "registerAbi",
  "formatTrace",
  "decodeRevert",
] as const;
