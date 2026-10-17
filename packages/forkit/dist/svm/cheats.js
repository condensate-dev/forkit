/**
 * forkit/svm cheatcodes, each one a `surfnet_*` method of the pinned surfpool (1.6.1; method names
 * and parameter shapes from that tag's crates/core/src/rpc/surfnet_cheatcodes.rs). Balances
 * that a cheatcode writes are read back, as the EVM `deal` does.
 */
import { readFile } from "node:fs/promises";
import { address, getAddressEncoder, getProgramDerivedAddress, } from "@solana/kit";
import { DealError, ForkitError } from "../errors.js";
// Program and sysvar ids, as surfpool 1.6.1's source spells them.
export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ADDRESS = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const BPF_LOADER_UPGRADEABLE_ADDRESS = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const SYSVAR_CLOCK_ADDRESS = address("SysvarC1ock11111111111111111111111111111111");
/** Bytes before the ELF in an upgradeable program's programdata account (loader v3 metadata). */
const PROGRAMDATA_METADATA_BYTES = 45;
/** surfpool's RPC body limit is 15 MiB; a 2 MiB chunk is 4 MiB of hex. */
const ETCH_CHUNK_BYTES = 2 * 1024 * 1024;
function toHex(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}
function toBigInt(value, what) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new ForkitError(`forkit: ${what} must be an integer, got ${value}`);
    }
    const n = BigInt(value);
    if (n < 0n)
        throw new ForkitError(`forkit: ${what} must not be negative, got ${n}`);
    return n;
}
/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export async function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM_ADDRESS) {
    const encoder = getAddressEncoder();
    const [ata] = await getProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        seeds: [encoder.encode(owner), encoder.encode(tokenProgram), encoder.encode(mint)],
    });
    return ata;
}
/** The programdata account of an upgradeable program. */
export async function programDataAddress(programId) {
    const [pda] = await getProgramDerivedAddress({
        programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
        seeds: [getAddressEncoder().encode(programId)],
    });
    return pda;
}
/** Decode the 40-byte `Clock` sysvar: slot, epoch start, epoch, leader schedule epoch, unix time. */
export function decodeClock(data) {
    if (data.length < 40)
        throw new ForkitError(`forkit: the Clock sysvar has ${data.length} bytes`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
        slot: view.getBigUint64(0, true),
        epoch: view.getBigUint64(16, true),
        unixTimestamp: view.getBigInt64(32, true),
    };
}
async function accountBytes(rpc, account) {
    const { value } = await rpc.getAccountInfo(account, { encoding: "base64" }).send();
    if (value === null)
        return null;
    return { ...value, bytes: Buffer.from(value.data[0], "base64") };
}
export function createCheats(rpc, request) {
    const clock = async () => {
        const account = await accountBytes(rpc, SYSVAR_CLOCK_ADDRESS);
        if (account === null)
            throw new ForkitError("forkit: the surfnet has no Clock sysvar");
        return decodeClock(account.bytes);
    };
    const timeTravel = (config) => request("surfnet_timeTravel", [config]);
    const setAccount = async (account, patch) => {
        await request("surfnet_setAccount", [
            account,
            {
                ...(patch.lamports === undefined ? {} : { lamports: toBigInt(patch.lamports, "lamports") }),
                ...(patch.data === undefined ? {} : { data: toHex(patch.data) }),
                ...(patch.owner === undefined ? {} : { owner: patch.owner }),
                ...(patch.executable === undefined ? {} : { executable: patch.executable }),
                ...(patch.rentEpoch === undefined
                    ? {}
                    : { rentEpoch: toBigInt(patch.rentEpoch, "rentEpoch") }),
            },
        ]);
    };
    return {
        setAccount,
        async dealSol(account, lamports) {
            await setAccount(account, { lamports });
            const { value } = await rpc.getBalance(account).send();
            if (value !== lamports) {
                throw new DealError(`forkit: dealSol set ${account} to ${lamports} lamports, but its balance reads ${value}.`);
            }
        },
        async deal(mint, owner, amount, options = {}) {
            const units = toBigInt(amount, "amount");
            let tokenProgram = options.tokenProgram;
            if (tokenProgram === undefined) {
                const { value } = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
                if (value === null) {
                    throw new DealError(`forkit: deal: mint ${mint} does not exist on the surfnet or its fork source.`);
                }
                if (value.owner !== TOKEN_PROGRAM_ADDRESS && value.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
                    throw new DealError(`forkit: deal: ${mint} is owned by ${value.owner}, not the Token or Token-2022 program, so it is not a mint. Pass { tokenProgram } if it is.`);
                }
                tokenProgram = value.owner;
            }
            await request("surfnet_setTokenAccount", [owner, mint, { amount: units }, tokenProgram]);
            const ata = await associatedTokenAddress(owner, mint, tokenProgram);
            const { value } = await rpc.getTokenAccountBalance(ata).send();
            if (BigInt(value.amount) !== units) {
                throw new DealError(`forkit: deal set ${owner}'s ${mint} account (${ata}) to ${units}, but it reads ${value.amount}.`);
            }
            return ata;
        },
        clock,
        async warp(seconds) {
            const delta = toBigInt(seconds, "seconds");
            const target = (await clock()).unixTimestamp + delta;
            // surfpool takes milliseconds here; the Clock sysvar is in seconds.
            await timeTravel({ absoluteTimestamp: target * 1000n });
            const after = await clock();
            if (after.unixTimestamp < target) {
                throw new ForkitError(`forkit: warp asked for unix time ${target}, but the Clock reads ${after.unixTimestamp}.`);
            }
            return after;
        },
        async roll(slots) {
            const delta = toBigInt(slots, "slots");
            const target = (await clock()).slot + delta;
            await timeTravel({ absoluteSlot: target });
            return await clock();
        },
        warpTo(target) {
            if ("unixTimestamp" in target) {
                return timeTravel({
                    absoluteTimestamp: toBigInt(target.unixTimestamp, "unixTimestamp") * 1000n,
                });
            }
            if ("slot" in target)
                return timeTravel({ absoluteSlot: toBigInt(target.slot, "slot") });
            return timeTravel({ absoluteEpoch: toBigInt(target.epoch, "epoch") });
        },
        pauseClock: () => request("surfnet_pauseClock"),
        resumeClock: () => request("surfnet_resumeClock"),
        async etch(programId, program, options = {}) {
            const elf = typeof program === "string" ? new Uint8Array(await readFile(program)) : program;
            if (elf.length < 4 ||
                elf[0] !== 0x7f ||
                elf[1] !== 0x45 ||
                elf[2] !== 0x4c ||
                elf[3] !== 0x46) {
                throw new ForkitError(`forkit: etch: ${typeof program === "string" ? program : "the bytes"} is not an ELF program (.so).`);
            }
            // surfnet_writeProgram writes at an offset and never shrinks the account, so a smaller
            // program over a bigger one would keep the old tail. Zero it, as a real deploy's
            // programdata is zero-padded.
            const existing = await accountBytes(rpc, await programDataAddress(programId));
            const room = existing === null ? 0 : existing.bytes.length - PROGRAMDATA_METADATA_BYTES;
            const image = new Uint8Array(Math.max(room, elf.length));
            image.set(elf);
            for (let offset = 0; offset < image.length; offset += ETCH_CHUNK_BYTES) {
                const chunk = image.subarray(offset, offset + ETCH_CHUNK_BYTES);
                await request("surfnet_writeProgram", [
                    programId,
                    toHex(chunk),
                    offset,
                    ...(options.authority === undefined ? [] : [options.authority]),
                ]);
            }
            const account = await accountBytes(rpc, programId);
            if (account === null || !account.executable) {
                throw new ForkitError(`forkit: etch wrote ${programId}, but it is not an executable program.`);
            }
        },
        async setProgramAuthority(programId, authority) {
            await request("surfnet_setProgramAuthority", [programId, authority]);
        },
        async reset(account, options = {}) {
            if (account === undefined) {
                await request("surfnet_resetNetwork");
                return;
            }
            await request("surfnet_resetAccount", [
                account,
                { includeOwnedAccounts: options.includeOwnedAccounts ?? false },
            ]);
        },
    };
}
//# sourceMappingURL=cheats.js.map