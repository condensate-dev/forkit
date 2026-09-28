import {
  type Address,
  type Chain,
  createTestClient,
  http,
  publicActions,
  walletActions,
} from "viem";

/** Build the viem client forkit hands out: test + public + wallet actions over one anvil. */
export function createForkClient<
  TChain extends Chain,
  TAccount extends Address | undefined = undefined,
>(chain: TChain, url: string, account?: TAccount) {
  return createTestClient({
    mode: "anvil",
    chain,
    account,
    transport: http(url),
    // anvil automines, so poll fast and never serve a cached block number after warp/roll.
    pollingInterval: 50,
    cacheTime: 0,
  })
    .extend(publicActions)
    .extend(walletActions);
}

/** viem client with test, public and wallet actions, bound to one fork. */
export type ForkClient<TChain extends Chain = Chain> = ReturnType<
  typeof createForkClient<TChain, undefined>
>;

/** A {@link ForkClient} whose default account is an impersonated address (see `prank`). */
export type PrankClient<TChain extends Chain = Chain> = ReturnType<
  typeof createForkClient<TChain, Address>
>;

/** Untyped JSON-RPC escape hatch for anvil methods viem does not type (e.g. `anvil_dealERC20`). */
export type RawRequest = (args: {
  method: string;
  params?: readonly unknown[];
}) => Promise<unknown>;

export function rawRequest(client: { request: unknown }): RawRequest {
  return client.request as RawRequest;
}
