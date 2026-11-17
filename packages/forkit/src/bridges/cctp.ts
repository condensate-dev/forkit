/**
 * `bridge.cctp(f)`: a simulator for Circle CCTP, v1 and v2.
 *
 * On the origin chain, `depositForBurn` on Circle's TokenMessenger burns USDC and emits
 * `DepositForBurn`. The two versions emit events with the same name and different fields:
 * - v1, `TokenMessenger.sol`: `DepositForBurn(uint64 indexed nonce, address indexed burnToken,
 *   uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain,
 *   bytes32 destinationTokenMessenger, bytes32 destinationCaller)`.
 * - v2, `TokenMessengerV2.sol`: `DepositForBurn(address indexed burnToken, uint256 amount,
 *   address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain,
 *   bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee,
 *   uint32 indexed minFinalityThreshold, bytes hookData)`.
 * Source: https://github.com/circlefin/evm-cctp-contracts (src/TokenMessenger.sol and
 * src/v2/TokenMessengerV2.sol). Both topics were checked against live Base logs in November 2026.
 *
 * On the destination, Circle's attestation and `receiveMessage` mint USDC to the mint recipient.
 * forkit has no attester, so it credits the recipient with `deal`. That is not a real mint: the
 * token's total supply does not change, no `Transfer` event is emitted, and no transaction runs.
 * See docs/guides/bridges-cctp.md.
 */
import {
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  isHex,
  pad,
  parseAbi,
  parseAbiItem,
  size,
  slice,
  zeroAddress,
} from "viem";
import { ForkitError } from "../errors.ts";
import type { Fork } from "../types.ts";
import {
  type BridgeSimulator,
  type BridgeSimulatorOptions,
  custom,
  type Deposit,
  type FailedFill,
  type Fill,
  type FillContext,
  type FillResult,
  type MultiFork,
  pickSimulatorOptions,
} from "./core.ts";

export const cctpDepositForBurnV1Event = parseAbiItem(
  "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
);

export const cctpDepositForBurnV2Event = parseAbiItem(
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
);

/** What the simulator reads on the destination to find the token to credit. */
export const cctpTokenMessengerAbi = parseAbi([
  "function localMinter() view returns (address)",
  "function localMessageTransmitter() view returns (address)",
]);
export const cctpTokenMinterAbi = parseAbi([
  "function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)",
]);

/**
 * Circle's domain of each chain, by chain id. Source: Circle's docs, "Supported Chains and
 * Domains" (https://developers.circle.com/cctp/supported-domains). Each entry was checked on
 * chain in November 2026: `localDomain()` of the MessageTransmitterV2 at
 * 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64.
 */
export const CCTP_DOMAINS: Readonly<Record<number, number>> = {
  1: 0, // Ethereum
  43114: 1, // Avalanche C-Chain
  10: 2, // OP Mainnet
  42161: 3, // Arbitrum One
  8453: 6, // Base
  137: 7, // Polygon PoS
};

/**
 * TokenMessengerV2, at one address on every chain in {@link CCTP_DOMAINS}. Checked on chain in
 * November 2026: its `localMessageTransmitter()` is the MessageTransmitterV2 on each.
 */
export const CCTP_TOKEN_MESSENGER_V2: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

/**
 * The v1 TokenMessenger on the chains forkit checked: Base (it emits the v1 event), Ethereum
 * (the destination messenger in Base's logs) and OP Mainnet (its minter maps Base USDC to OP
 * USDC). For another chain, pass its address in `tokenMessengers`.
 */
export const CCTP_TOKEN_MESSENGERS_V1: Readonly<Record<number, Address>> = {
  1: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
  10: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
  8453: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
};

/** Fields both versions of `DepositForBurn` carry. */
interface CctpDepositCommon {
  burnToken: Address;
  amount: bigint;
  depositor: Address;
  /** The recipient on the destination, as bytes32. An EVM address is its last 20 bytes. */
  mintRecipient: Hex;
  destinationDomain: number;
  destinationTokenMessenger: Hex;
  /** Who may call `receiveMessage`; zero for anyone. The simulator reports it and ignores it. */
  destinationCaller: Hex;
}

/** A decoded v1 `DepositForBurn`. */
export interface CctpV1DepositArgs extends CctpDepositCommon {
  version: 1;
  nonce: bigint;
}

/** A decoded v2 `DepositForBurn`. */
export interface CctpV2DepositArgs extends CctpDepositCommon {
  version: 2;
  maxFee: bigint;
  /** 1000 or less is a Fast Transfer; 2000 is a Standard Transfer. */
  minFinalityThreshold: number;
  /** Data for the integrator's own hook. CCTP does not run it, and neither does the simulator. */
  hookData: Hex;
}

export type CctpDepositArgs = CctpV1DepositArgs | CctpV2DepositArgs;
export type CctpDeposit = Deposit<CctpDepositArgs>;
export type CctpFill = Fill<CctpDepositArgs>;
export type CctpFailedFill = FailedFill<CctpDepositArgs>;

/** What `bridge.cctp` reports in each fill's `details`. */
export interface CctpFillDetails {
  version: 1 | 2;
  /** The USDC credited on the destination. */
  token: Address;
  recipient: Address;
  /** The fee kept out of `amount`. Always 0 for v1. */
  fee: bigint;
  destinationCaller: Hex;
  /** Always `deal`: the balance was set, nothing was minted. */
  credit: "deal";
}

export interface CctpOptions extends BridgeSimulatorOptions {
  /**
   * The TokenMessenger(s) to watch, per origin chain id, merged over the defaults (v2 on every
   * chain in {@link CCTP_DOMAINS}, v1 where {@link CCTP_TOKEN_MESSENGERS_V1} has it). Every
   * forked chain with an entry is an origin.
   */
  tokenMessengers?: Readonly<Record<number, Address | readonly Address[]>>;
  /** Circle domain per chain id, merged over {@link CCTP_DOMAINS}. */
  domains?: Readonly<Record<number, number>>;
  /**
   * The token to credit, per destination chain id. Default: what the destination
   * TokenMessenger's minter maps the burned token to (`getLocalToken`), as the real mint does.
   */
  usdc?: Readonly<Record<number, Address>>;
  /**
   * The v2 fee kept out of the amount. Default: `maxFee` for a Fast Transfer
   * (`minFinalityThreshold` below 2000), 0 for a Standard Transfer. Circle's real fee is set at
   * attestation and is at most `maxFee`, so the default is the least the recipient can get.
   */
  fee?: (args: CctpV2DepositArgs) => bigint;
}

/** A CCTP deposit cannot be credited. */
export class CctpError extends ForkitError {
  override name = "CctpError";
}

/** The EVM address in a bytes32, or an error for a value that is not one. */
function addressOf(value: Hex, what: string): Address {
  if (!isHex(value) || size(value) !== 32 || BigInt(slice(value, 0, 12)) !== 0n) {
    throw new CctpError(
      `forkit: CCTP ${what} ${value} is not an EVM address in a bytes32 (12 zero bytes, then 20). A deposit to a non-EVM domain cannot be credited on a fork; pass unforkedDestination: "skip" or "deliver" and leave its domain out of \`domains\`.`,
    );
  }
  return getAddress(slice(value, 12));
}

const field = <T>(
  args: Record<string, unknown>,
  name: string,
  check: (v: unknown) => v is T,
): T => {
  const value = args[name];
  if (!check(value)) {
    throw new CctpError(`forkit: CCTP DepositForBurn field ${name} is ${String(value)}.`);
  }
  return value;
};
const isBigint = (v: unknown): v is bigint => typeof v === "bigint";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isHexValue = (v: unknown): v is Hex => typeof v === "string" && isHex(v);

/** Decode the args of either `DepositForBurn`, as viem parsed them. */
export function decodeCctpDeposit(version: 1 | 2, args: Record<string, unknown>): CctpDepositArgs {
  const common: CctpDepositCommon = {
    burnToken: getAddress(field(args, "burnToken", isHexValue)),
    amount: field(args, "amount", isBigint),
    depositor: getAddress(field(args, "depositor", isHexValue)),
    mintRecipient: field(args, "mintRecipient", isHexValue),
    destinationDomain: field(args, "destinationDomain", isNumber),
    destinationTokenMessenger: field(args, "destinationTokenMessenger", isHexValue),
    destinationCaller: field(args, "destinationCaller", isHexValue),
  };
  switch (version) {
    case 1:
      return { ...common, version, nonce: field(args, "nonce", isBigint) };
    case 2:
      return {
        ...common,
        version,
        maxFee: field(args, "maxFee", isBigint),
        minFinalityThreshold: field(args, "minFinalityThreshold", isNumber),
        hookData: field(args, "hookData", isHexValue),
      };
    default: {
      const never: never = version;
      throw new CctpError(`forkit: unknown CCTP version ${String(never)}`);
    }
  }
}

/** The fee `bridge.cctp` keeps by default. */
export function cctpDefaultFee(args: CctpV2DepositArgs): bigint {
  return args.minFinalityThreshold < 2000 ? args.maxFee : 0n;
}

/** The USDC on `destination` that the destination TokenMessenger mints for `burnToken`. */
async function localToken(
  destination: Fork,
  args: CctpDepositArgs,
  originDomain: number,
): Promise<Address> {
  const messenger = addressOf(args.destinationTokenMessenger, "destinationTokenMessenger");
  let token: Address;
  try {
    const minter = await destination.client.readContract({
      address: messenger,
      abi: cctpTokenMessengerAbi,
      functionName: "localMinter",
    });
    token = await destination.client.readContract({
      address: minter,
      abi: cctpTokenMinterAbi,
      functionName: "getLocalToken",
      args: [originDomain, pad(args.burnToken)],
    });
  } catch (error) {
    throw new CctpError(
      `forkit: could not read the token that CCTP mints on chain ${destination.chain.id} (TokenMessenger ${messenger} → localMinter() → getLocalToken(${originDomain}, ${args.burnToken})). Pass usdc: { ${destination.chain.id}: "0x…" }.`,
      { cause: error },
    );
  }
  if (isAddressEqual(token, zeroAddress)) {
    throw new CctpError(
      `forkit: CCTP's minter on chain ${destination.chain.id} has no local token for ${args.burnToken} from domain ${originDomain}. Pass usdc: { ${destination.chain.id}: "0x…" }.`,
    );
  }
  return getAddress(token);
}

function cctpSimulator(f: MultiFork, options: CctpOptions = {}): BridgeSimulator<CctpDepositArgs> {
  const domains: Record<number, number> = { ...CCTP_DOMAINS, ...options.domains };
  const chainOfDomain = new Map<number, number>();
  for (const [chainId, domain] of Object.entries(domains)) {
    if (chainOfDomain.has(domain)) {
      throw new CctpError(
        `forkit: CCTP domain ${domain} is given to chains ${chainOfDomain.get(domain)} and ${chainId}; each domain is one chain.`,
      );
    }
    chainOfDomain.set(domain, Number(chainId));
  }

  const messengers: Record<number, readonly Address[]> = {};
  for (const chainId of Object.keys(CCTP_DOMAINS).map(Number)) {
    const v1 = CCTP_TOKEN_MESSENGERS_V1[chainId];
    messengers[chainId] =
      v1 === undefined ? [CCTP_TOKEN_MESSENGER_V2] : [CCTP_TOKEN_MESSENGER_V2, v1];
  }
  for (const [chainId, address] of Object.entries(options.tokenMessengers ?? {})) {
    messengers[Number(chainId)] = [address].flat();
  }
  const forked = new Set(f.forks.map((m) => m.chain.id));
  const origins = Object.keys(messengers)
    .map(Number)
    .filter((id) => forked.has(id));
  if (origins.length === 0) {
    throw new CctpError(
      `forkit: bridge.cctp found no TokenMessenger on a forked chain (${[...forked].join(", ")}). Pass tokenMessengers: { [chainId]: "0x…" } and domains: { [chainId]: domain }.`,
    );
  }
  const domainOf = (chainId: number): number => {
    const domain = domains[chainId];
    if (domain === undefined) {
      throw new CctpError(
        `forkit: bridge.cctp has a TokenMessenger on chain ${chainId} but no CCTP domain for it. Pass domains: { ${chainId}: domain }.`,
      );
    }
    return domain;
  };
  for (const id of origins) domainOf(id);
  const address = Object.fromEntries(origins.map((id) => [id, messengers[id] ?? []]));

  const destinationOf = (args: Record<string, unknown>): number => {
    const domain = field(args, "destinationDomain", isNumber);
    const chainId = chainOfDomain.get(domain);
    if (chainId === undefined) {
      throw new CctpError(
        `forkit: a CCTP deposit goes to domain ${domain}, which has no chain id. Pass domains: { [chainId]: ${domain} }.`,
      );
    }
    return chainId;
  };

  const part = (version: 1 | 2) => {
    async function onDeposit({
      deposit,
      destination,
    }: FillContext<Record<string, unknown>>): Promise<FillResult> {
      const args = decodeCctpDeposit(version, deposit.args);
      const originDomain = domainOf(deposit.originChainId);
      const recipient = addressOf(args.mintRecipient, "mintRecipient");
      const token =
        options.usdc?.[destination.chain.id] ?? (await localToken(destination, args, originDomain));
      let fee = 0n;
      if (args.version === 2) {
        fee = (options.fee ?? cctpDefaultFee)(args);
        if (fee < 0n || fee > args.maxFee || fee > args.amount) {
          throw new CctpError(
            `forkit: CCTP fee ${fee} for deposit ${deposit.id} is outside 0 to min(maxFee ${args.maxFee}, amount ${args.amount}).`,
          );
        }
      }
      const credited = args.amount - fee;
      const held = await destination.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [recipient],
      });
      await destination.deal(token, recipient, held + credited);
      const details: CctpFillDetails = {
        version,
        token,
        recipient,
        fee,
        destinationCaller: args.destinationCaller,
        credit: "deal",
      };
      return { txHashes: [], outputAmount: credited, details: { ...details } };
    }
    const sim = custom(f, {
      name: "cctp",
      originEvent: {
        event: version === 1 ? cctpDepositForBurnV1Event : cctpDepositForBurnV2Event,
        address,
      },
      destinationOf,
      onDeposit,
      // A v1 burn is known by its origin domain and nonce. A v2 burn gets its nonce at
      // attestation, so it keeps the deposit id.
      journalKey: (deposit) =>
        version === 1
          ? `v1-${domainOf(deposit.originChainId)}-${String(deposit.args.nonce)}`
          : `v2-${deposit.id}`,
      ...pickSimulatorOptions(options),
    });
    return { version, sim };
  };
  const parts = [part(1), part(2)];

  const view = <T extends { address: Address; args: Record<string, unknown> }>(
    version: 1 | 2,
    deposit: T,
  ) => ({
    ...deposit,
    address: getAddress(deposit.address),
    args: decodeCctpDeposit(version, deposit.args),
  });

  return {
    get pending() {
      return parts.flatMap(({ version, sim }) => sim.pending.map((d) => view(version, d)));
    },
    get fills() {
      return parts.flatMap(({ version, sim }) =>
        sim.fills.map((x) => ({ ...x, deposit: view(version, x.deposit) })),
      );
    },
    get failed() {
      return parts.flatMap(({ version, sim }) =>
        sim.failed.map((x) => ({ ...x, deposit: view(version, x.deposit) })),
      );
    },
    async poll() {
      const found: CctpDeposit[] = [];
      for (const { version, sim } of parts)
        found.push(...(await sim.poll()).map((d) => view(version, d)));
      return found;
    },
    // Both parts settle even when the first rejects, so a bad v1 burn does not hold v2 burns.
    async settle() {
      const made: CctpFill[] = [];
      const errors: unknown[] = [];
      for (const { version, sim } of parts) {
        try {
          made.push(
            ...(await sim.settle()).map((x) => ({ ...x, deposit: view(version, x.deposit) })),
          );
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `forkit: CCTP v1 and v2 deposits both failed:\n${errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n")}`,
        );
      }
      return made;
    },
  };
}

/**
 * Circle CCTP simulator (v1 and v2) on a multi-chain fork.
 *
 * ```ts
 * const cctp = bridge.cctp(f);
 * // ... depositForBurn on Base's TokenMessengerV2, to domain 2 (OP Mainnet) ...
 * const [fill] = await cctp.settle(); // the mint recipient holds more USDC on OP Mainnet
 * ```
 */
export const cctp = Object.assign(cctpSimulator, {
  domains: CCTP_DOMAINS,
  tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
  tokenMessengersV1: CCTP_TOKEN_MESSENGERS_V1,
});
