import { createConfig } from "@ponder/core";
import { http } from "viem";
import { erc20ABI } from "./abis/erc20ABI";

const endBlock = 5_395_000;
const indexRange = 10_000;
const chainId = 11155111; // sepolia
// const syncToFile = "../../sync1.db";
const syncToFile = "../../baseline2";
console.log("syncing to", syncToFile);
const network = "sepolia";
// currently points to our full sepolia node
const rpcUrl = "http://localhost:8545";
const database = "baseline1";
const pg = `postgres://postgres:password@localhost:5432/${database}`;
export default createConfig({
  networks: {
    [network]: {
      chainId,
      transport: http(rpcUrl),
    },
  },
  database: {
    kind: "postgres",
    /** Path to SQLite database file. Default: `".ponder/store"`. */
    connectionString: pg,
  },
  contracts: {
    ERC20: {
      network: network,
      abi: erc20ABI,
      address: "0x4B8eed87b61023F5BEcCeBd2868C058FEe6B7Ac7",
      startBlock: endBlock - indexRange,
      endBlock,
    },
  },
});
