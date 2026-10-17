import { type Address, type Chain, type Client, type HttpTransport, type ParseAccount, type PublicActions, type TestActions, type TestRpcSchema, type WalletActions } from "viem";
/** Untyped JSON-RPC escape hatch for anvil methods viem does not type (e.g. `anvil_dealERC20`). */
export type RawRequest = (args: {
    method: string;
    params?: readonly unknown[];
}) => Promise<unknown>;
export declare function rawRequest(client: {
    request: unknown;
}): RawRequest;
/** Property name of the formatted trace forkit attaches to a reverted transaction's error. */
export declare const TRACE_PROPERTY = "forkitTrace";
/** The trace forkit attached to an error, if any (see `traces` in fork options). */
export declare function traceOf(error: unknown): string | undefined;
/**
 * The client {@link createForkClient} returns, spelled with viem's public types so that the
 * published declarations name it instead of reaching into viem's internal modules.
 */
export type ForkClientOf<TChain extends Chain, TAccount extends Address | undefined> = Client<HttpTransport, TChain, ParseAccount<TAccount>, TestRpcSchema<"anvil">, {
    mode: "anvil";
} & TestActions & PublicActions<HttpTransport, TChain, ParseAccount<TAccount>> & WalletActions<TChain, ParseAccount<TAccount>>>;
/** Build the viem client forkit hands out: test + public + wallet actions over one anvil. */
export declare function createForkClient<TChain extends Chain, TAccount extends Address | undefined = undefined>(chain: TChain, url: string, account?: TAccount, traces?: boolean, warn?: (message: string) => void): ForkClientOf<TChain, TAccount>;
/** viem client with test, public and wallet actions, bound to one fork. */
export type ForkClient<TChain extends Chain = Chain> = ForkClientOf<TChain, undefined>;
/** A {@link ForkClient} whose default account is an impersonated address (see `prank`). */
export type PrankClient<TChain extends Chain = Chain> = ForkClientOf<TChain, Address>;
//# sourceMappingURL=client.d.ts.map