/** @type {import("jest").Config} */
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/jest.smoke.ts"],
  transform: { "^.+\\.ts$": "@swc/jest" },
};
