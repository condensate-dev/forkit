/**
 * `@condensate_dev/forkit/payments`: stablecoin payments on a fork. Sign EIP-2612 permits, EIP-3009
 * authorizations and Permit2 transfers against real tokens with deterministic test keys, get past
 * USDT's and USDC's quirks, and assert what the payment changed.
 *
 * - Keys and nonces: {@link testAccount}, {@link testAddress}, {@link authorizationNonce},
 *   {@link permit2Nonce}
 * - EIP-2612: {@link signPermit}; EIP-3009: {@link signTransferWithAuthorization},
 *   {@link signReceiveWithAuthorization}; the domain: {@link tokenDomain}
 * - Permit2: {@link signPermitTransferFrom} (SignatureTransfer), {@link signPermitSingle}
 *   (AllowanceTransfer), {@link permit2Domain}
 * - Token quirks: {@link forceApprove}, {@link safeTransfer} (USDT), {@link blacklist},
 *   {@link pause} (USDC)
 * - Assertions: {@link expectAllowance}, {@link expectPermitNonce},
 *   {@link expectAuthorizationUsed}, {@link expectPermit2NonceUsed}, {@link expectPermit2Allowance}
 *
 * Signing and assertions only read, so they take a viem client (`f.client`, or any client);
 * the token helpers send transactions as someone, so they take the fork. See
 * docs/guides/payments.md.
 */
export {
  eip2612Abi,
  eip3009Abi,
  fiatTokenAdminAbi,
  noReturnErc20Abi,
  permit2Abi,
} from "./abi.ts";
export {
  expectAllowance,
  expectAuthorizationUnused,
  expectAuthorizationUsed,
  expectPermit2Allowance,
  expectPermit2NonceUnused,
  expectPermit2NonceUsed,
  expectPermitNonce,
  type Permit2Allowance,
} from "./assertions.ts";
export {
  PERMIT2,
  type Permit2Options,
  type PermitSingle,
  permit2Domain,
  permit2Nonce,
  type SignedPermitSingle,
  type SignedPermitTransferFrom,
  type SignPermitSingleParameters,
  type SignPermitTransferFromParameters,
  signPermitSingle,
  signPermitTransferFrom,
} from "./permit2.ts";
export {
  authorizationNonce,
  type SignAuthorizationParameters,
  type SignedAuthorization,
  type SignedPermit,
  type SignPermitParameters,
  type SplitSignature,
  signPermit,
  signReceiveWithAuthorization,
  signTransferWithAuthorization,
  testAccount,
  testAddress,
  tokenDomain,
} from "./sign.ts";
export {
  blacklist,
  type ForceApproveParameters,
  forceApprove,
  pause,
  type SafeTransferParameters,
  safeTransfer,
} from "./tokens.ts";
