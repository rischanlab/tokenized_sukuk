import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    ...(process.env.SOLC_PATH ? { path: process.env.SOLC_PATH } : {}),
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  // Solidity property tests (contracts/fuzz/*.t.sol): fixed seed, 1,000 runs.
  test: {
    solidity: {
      fuzz: { runs: Number(process.env.FUZZ_RUNS ?? 1000), seed: "0x5eed" },
    },
  },
});
