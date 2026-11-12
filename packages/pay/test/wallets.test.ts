import { describe, expect, it } from "vitest";
import {
  addChainParams,
  associatedTokenAccount,
  ATA_PROGRAM,
  base58,
  erc20BalanceOf,
  erc20Transfer,
  EVM_CHAINS,
  evmAsset,
  evmChainOf,
  evmPayment,
  evmTxOk,
  fromBase58,
  mintDecimals,
  programAddress,
  quantity,
  solanaKey,
  solanaPayment,
  solanaSignature,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  uintOf,
} from "../src/index.ts";

// Read on mainnet 2026-11-12 with no money: USDT0 on Arbitrum answers decimals() = 6, and this very transfer data
// sent by eth_call from a holder (0xB38e…891D) returns true; the Solana transactions below pass simulateTransaction
// (sigVerify off) for SOL and for USDC with the deposit's token account created on the way.
const USDT0 = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
const DEPOSIT = "0x9d366cbb21925d26e60b58124f3dba9474b208b8";
const HOLDER = "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D";

describe("paying from an EVM wallet", () => {
  it("names only networks whose chain id is certain", () => {
    expect(EVM_CHAINS.map((c) => [c.id, c.chainId])).toEqual([
      ["eth", 1],
      ["arb", 42161],
      ["base", 8453],
      ["bsc", 56],
      ["pol", 137],
      ["op", 10],
      ["avax", 43114],
      ["gnosis", 100],
      ["scroll", 534352],
    ]);
    expect(evmChainOf("arb")?.explorer).toBe("https://arbiscan.io");
    expect(evmChainOf("monad")).toBeNull();
    expect(evmChainOf("sol")).toBeNull();
  });

  it("encodes transfer(to, amount) and the two reads as the token expects them", () => {
    expect(erc20Transfer("0x000000000000000000000000000000000000dEaD", 1_000_000n)).toBe(
      "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240",
    );
    expect(erc20BalanceOf(HOLDER)).toBe("0x70a08231000000000000000000000000b38e8c17e38363af6ebdcb3dae12e0243582891d");
    expect(() => erc20Transfer("0x123", 1n)).toThrow();
    expect(() => erc20Transfer(DEPOSIT, 0n)).toThrow();
    expect(uintOf("0x0000000000000000000000000000000000000000000000000000000000000006")).toBe(6n);
    expect(uintOf("0x")).toBeNull();
    expect(uintOf(null)).toBeNull();
  });

  it("pays a token through its contract and the network's own coin as value, bound to the network's chain id", () => {
    const arb = evmChainOf("arb")!;
    const usdt = evmAsset(arb, { assetId: `nep141:arb-${USDT0}.omft.near`, symbol: "USDT", contract: USDT0, decimals: 6 })!;
    expect(evmPayment({ chain: arb, asset: usdt, from: HOLDER, depositAddress: DEPOSIT, amount: 1_000_000n })).toEqual({
      from: HOLDER,
      to: USDT0,
      data: `0xa9059cbb000000000000000000000000${DEPOSIT.slice(2)}00000000000000000000000000000000000000000000000000000000000f4240`,
      value: "0x0",
      chainId: "0xa4b1",
    });
    const eth = evmAsset(arb, { assetId: "nep141:arb.omft.near", symbol: "ETH", contract: null, decimals: 18 })!;
    expect(evmPayment({ chain: arb, asset: eth, from: HOLDER, depositAddress: DEPOSIT, amount: 10n ** 16n })).toEqual({
      from: HOLDER,
      to: DEPOSIT,
      value: "0x2386f26fc10000",
      chainId: "0xa4b1",
    });
  });

  it("builds no payment it cannot be sure of", () => {
    const bsc = evmChainOf("bsc")!;
    const arb = evmChainOf("arb")!;
    expect(evmAsset(bsc, { assetId: "nep141:bnb.omdep.near", symbol: "ETH", contract: null, decimals: 18 })).toBeNull();
    expect(evmAsset(bsc, { assetId: "nep141:bnb.omdep.near", symbol: "BNB", contract: null, decimals: 8 })).toBeNull();
    expect(evmAsset(bsc, { assetId: "nep141:bnb-x.omdep.near", symbol: "USDT", contract: "not-an-address", decimals: 18 })).toBeNull();
    // The list's contract field alone never decides: 1Click's asset id has to name the same contract.
    expect(evmAsset(arb, { assetId: `nep141:arb-0x${"11".repeat(20)}.omft.near`, symbol: "USDT", contract: USDT0, decimals: 6 })).toBeNull();
    expect(evmAsset(arb, { assetId: "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo", symbol: "USDT", contract: USDT0, decimals: 6 })).toBeNull();
    expect(() => evmPayment({ chain: arb, asset: { kind: "native" }, from: HOLDER, depositAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", amount: 1n })).toThrow();
  });

  it("adds a network the wallet does not know, and reads a transaction hash", () => {
    expect(addChainParams(evmChainOf("arb")!)).toEqual({
      chainId: "0xa4b1",
      chainName: "Arbitrum One",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://arb1.arbitrum.io/rpc"],
      blockExplorerUrls: ["https://arbiscan.io"],
    });
    expect(quantity(534352)).toBe("0x82750");
    expect(evmTxOk(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(evmTxOk("0x1234")).toBe(false);
  });
});

describe("paying from a Solana wallet", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const TO = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const BLOCKHASH = "6G5bT82cfu1WVFDJsGhvr4AJS26L6F3jPxmtekZZ7S7p";

  it("finds the associated token account the chain has (read on mainnet)", () => {
    expect(associatedTokenAccount(PAYER, USDC)).toBe("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B");
    // The same owner and mint under Token-2022 is another account.
    expect(associatedTokenAccount(PAYER, USDC, TOKEN_2022_PROGRAM)).not.toBe("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B");
    expect(() => programAddress([new Uint8Array(32)], "not base58 0OIl")).toThrow();
  });

  it("reads a mint's decimals from its account (USDC, as mainnet answered)", () => {
    const usdc = "AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmbMFC27lm+HwAGAQEAAABicKqKWcWUBbRShshncubNEm6bil06OFNtN/e0FOi2Zw==";
    expect(mintDecimals(usdc)).toBe(6);
    expect(mintDecimals("AQID")).toBeNull();
    expect(mintDecimals("%%%")).toBeNull();
  });

  it("sends SOL with one System transfer: one signer, the deposit writable, the program read-only", () => {
    const tx = solanaPayment({ asset: { kind: "sol" }, payer: PAYER, depositAddress: TO, amount: 10_000_000n, blockhash: BLOCKHASH });
    // 1 empty signature, then the message.
    expect(tx[0]).toBe(1);
    expect([...tx.subarray(1, 65)].every((b) => b === 0)).toBe(true);
    const m = tx.subarray(65);
    expect([...m.subarray(0, 4)]).toEqual([1, 0, 1, 3]);
    const keys = [0, 1, 2].map((i) => base58(m.subarray(4 + i * 32, 36 + i * 32)));
    expect(keys).toEqual([PAYER, TO, SYSTEM_PROGRAM]);
    expect(base58(m.subarray(100, 132))).toBe(BLOCKHASH);
    // One instruction: program 2, accounts [0, 1], data = 2u32 ‖ 10 000 000u64.
    expect([...m.subarray(132)]).toEqual([1, 2, 2, 0, 1, 12, 2, 0, 0, 0, 0x80, 0x96, 0x98, 0, 0, 0, 0, 0]);
  });

  it("sends a token by creating the deposit's token account if needed, then TransferChecked with the mint's decimals", () => {
    const tx = solanaPayment({ asset: { kind: "token", mint: USDC, decimals: 6, tokenProgram: TOKEN_PROGRAM }, payer: PAYER, depositAddress: TO, amount: 1_000_000n, blockhash: BLOCKHASH });
    const m = tx.subarray(65);
    expect([...m.subarray(0, 4)]).toEqual([1, 0, 5, 8]);
    const keys = Array.from({ length: 8 }, (_, i) => base58(m.subarray(4 + i * 32, 36 + i * 32)));
    const source = associatedTokenAccount(PAYER, USDC);
    const dest = associatedTokenAccount(TO, USDC);
    expect(keys).toEqual([PAYER, source, dest, TO, USDC, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM]);
    const ixs = m.subarray(4 + 8 * 32 + 32);
    // CreateIdempotent: ATA program (7), [payer, dest, owner, mint, system, token], data [1].
    expect([...ixs.subarray(0, 11)]).toEqual([2, 7, 6, 0, 2, 3, 4, 5, 6, 1, 1]);
    // TransferChecked: token program (6), [source, mint, dest, owner], data 12 ‖ 1 000 000u64 ‖ 6.
    expect([...ixs.subarray(11)]).toEqual([6, 4, 1, 4, 2, 0, 10, 12, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0, 6]);
  });

  it("refuses what it cannot build for sure", () => {
    const base = { payer: PAYER, depositAddress: TO, amount: 1n, blockhash: BLOCKHASH };
    expect(() => solanaPayment({ ...base, asset: { kind: "token", mint: USDC, decimals: 6, tokenProgram: SYSTEM_PROGRAM } })).toThrow();
    expect(() => solanaPayment({ ...base, amount: 0n, asset: { kind: "sol" } })).toThrow();
    expect(() => solanaPayment({ ...base, depositAddress: PAYER, asset: { kind: "sol" } })).toThrow();
    expect(() => solanaPayment({ ...base, depositAddress: "0x9d366cbb21925d26e60b58124f3dba9474b208b8", asset: { kind: "sol" } })).toThrow();
    expect(solanaKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toEqual(fromBase58("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"));
    expect(solanaKey("short")).toBeNull();
  });

  it("names a signature as explorers do", () => {
    expect(solanaSignature(new Uint8Array(64).fill(1))).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    expect(solanaSignature(new Uint8Array(10))).toBeNull();
    expect(solanaSignature("not a signature")).toBeNull();
  });
});
