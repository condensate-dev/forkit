/**
 * The slices of verified ABIs the payment helpers call, written with viem's `parseAbi`.
 *
 * - EIP-2612 and EIP-3009: the EIPs, plus the `bytes signature` overloads of Circle's
 *   FiatTokenV2_2 (the USDC implementation on Ethereum and Base), verified on Etherscan, Basescan
 *   and Blockscout.
 * - EIP-5267 `eip712Domain()`: https://eips.ethereum.org/EIPS/eip-5267
 * - Permit2: Uniswap's interfaces (`IAllowanceTransfer.sol`, `ISignatureTransfer.sol`,
 *   `PermitErrors.sol`, `SignatureVerification.sol`) in https://github.com/Uniswap/permit2,
 *   verified at 0x000000000022D473030F116dDEE9F6B43aC78BA3.
 */
import { parseAbi } from "viem";

/**
 * EIP-2612 `permit`, plus the reads a signer needs: `nonces`, `DOMAIN_SEPARATOR`, `name`,
 * `version` and EIP-5267 `eip712Domain` (the last two are optional on a token). The `bytes
 * signature` overload of `permit` is FiatTokenV2_2's; viem picks an overload by its arguments.
 */
export const eip2612Abi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, bytes signature)",
]);

/**
 * EIP-3009: the `(v, r, s)` functions from the EIP, FiatTokenV2_2's `bytes signature` overloads,
 * and the events.
 */
export const eip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
]);

/** Circle's FiatToken (USDC, EURC) admin roles: the blacklister and the pauser. */
export const fiatTokenAdminAbi = parseAbi([
  "function blacklister() view returns (address)",
  "function isBlacklisted(address account) view returns (bool)",
  "function blacklist(address account)",
  "function unBlacklist(address account)",
  "function pauser() view returns (address)",
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "event Blacklisted(address indexed account)",
  "event UnBlacklisted(address indexed account)",
  "event Pause()",
  "event Unpause()",
]);

/**
 * ERC-20 as USDT on Ethereum implements it: `approve`, `transfer` and `transferFrom` return
 * nothing. viem's `erc20Abi` declares a `bool`, so `simulateContract` (or anything else that
 * decodes the result) fails on USDT with it; this ABI decodes.
 */
export const noReturnErc20Abi = parseAbi([
  "function approve(address spender, uint256 value)",
  "function transfer(address to, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/** The single-token parts of Permit2 (SignatureTransfer and AllowanceTransfer), with its events and errors. */
export const permit2Abi = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct SignatureTransferDetails { address to; uint256 requestedAmount; }",
  "struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }",
  "struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function permitTransferFrom(PermitTransferFrom permit, SignatureTransferDetails transferDetails, address owner, bytes signature)",
  "function permit(address owner, PermitSingle permitSingle, bytes signature)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
  "function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)",
  "function invalidateNonces(address token, address spender, uint48 newNonce)",
  "event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
  "event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
  "event NonceInvalidation(address indexed owner, address indexed token, address indexed spender, uint48 newNonce, uint48 oldNonce)",
  "event UnorderedNonceInvalidation(address indexed owner, uint256 word, uint256 mask)",
  "error AllowanceExpired(uint256 deadline)",
  "error ExcessiveInvalidation()",
  "error InsufficientAllowance(uint256 amount)",
  "error InvalidAmount(uint256 maxAmount)",
  "error InvalidContractSignature()",
  "error InvalidNonce()",
  "error InvalidSignature()",
  "error InvalidSignatureLength()",
  "error InvalidSigner()",
  "error LengthMismatch()",
  "error SignatureExpired(uint256 signatureDeadline)",
]);
