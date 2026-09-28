/** @type {import("jest").Config} */
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/jest.smoke.ts"],
  // Native ESM: forkit's dependencies (prool, viem) are ESM-only.
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      { jsc: { parser: { syntax: "typescript" }, target: "es2022" }, module: { type: "es6" } },
    ],
  },
};
