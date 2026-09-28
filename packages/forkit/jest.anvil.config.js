import base from "./jest.config.js";

/** jest adapter test against a local anvil (`bun run test:anvil`). */
export default { ...base, testMatch: ["<rootDir>/test/anvil/jest-adapter.test.ts"] };
