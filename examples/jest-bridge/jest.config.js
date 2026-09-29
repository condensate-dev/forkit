/** @type {import("jest").Config} */
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  // A cold run fetches fork state over the network; a replayed one takes a few seconds.
  testTimeout: 60_000,
  // Native ESM (run jest with NODE_OPTIONS=--experimental-vm-modules): viem and forkit are
  // ESM-only. swc strips the TypeScript.
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      { jsc: { parser: { syntax: "typescript" }, target: "es2022" }, module: { type: "es6" } },
    ],
  },
};
