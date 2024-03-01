import { mkdir, writeFile } from "node:fs/promises";
import type { Common } from "@/Ponder.js";
import type { Network } from "@/config/networks.js";
import type { FactoryCriteria, LogFilterCriteria } from "@/config/sources.js";
import type { SyncStore } from "@/sync-store/store.js";
import type { Block, Log, Transaction } from "@/types/eth.js";
import {
  type Checkpoint,
  checkpointMax,
  checkpointMin,
  isCheckpointGreaterThan,
  zeroCheckpoint,
} from "@/utils/checkpoint.js";
import { Emittery } from "@/utils/emittery.js";
import axios from "axios";
import type { Hex } from "viem";

const customrpc = process.env.CUSTOM_RPC;

let customRpcClient = undefined as ReturnType<typeof axios.create> | undefined;
if (customrpc) {
  customRpcClient = axios.create({ url: customrpc });
}

const callCustomRpc = async (
  args: GetEventsRequest,
): Promise<
  {
    events: {
      chainId: number;
      log: Log;
      block: Block;
      transaction: Transaction;
    }[];
    lastCheckpoint: Checkpoint | undefined;
  } & (
    | {
        hasNextPage: true;
        lastCheckpointInPage: Checkpoint;
      }
    | {
        hasNextPage: false;
        lastCheckpointInPage: undefined;
      }
  )
> => {
  const jsonRpcPayload = {
    id: "1",
    method: "ponder_getLogEvents",
    params: args,
  };
  const res = await customRpcClient!.post("/", jsonRpcPayload);
  if (res.data.error) {
    throw Error(res.data.error);
  }
  return res.data.result;
};

type GetEventsRequest = {
  fromCheckpoint: Checkpoint;
  toCheckpoint: Checkpoint;
  limit: number;
} & (
  | {
      logFilters: {
        id: string;
        chainId: number;
        criteria: LogFilterCriteria;
        fromBlock?: number;
        toBlock?: number;
        eventSelector: Hex;
      }[];
      factories?: undefined;
    }
  | {
      logFilters?: undefined;
      factories: {
        id: string;
        chainId: number;
        criteria: FactoryCriteria;
        fromBlock?: number;
        toBlock?: number;
        eventSelector: Hex;
      }[];
    }
);

type SyncGatewayEvents = {
  /**
   * Emitted when a new event checkpoint is reached. This is the minimum timestamp
   * at which events are available across all registered networks.
   */
  newCheckpoint: Checkpoint;
  /**
   * Emitted when a new finality checkpoint is reached. This is the minimum timestamp
   * at which events are finalized across all registered networks.
   */
  newFinalityCheckpoint: Checkpoint;
  /**
   * Emitted when a reorg has been detected on any registered network. The value
   * is the safe/"common ancestor" checkpoint.
   */
  reorg: Checkpoint;
  /**
   * Emitted when the historical sync has completed across all registered networks.
   */
  hasCompletedHistoricalSync: Checkpoint;
};

type SyncGatewayMetrics = {};

let recordIndex = 0;
export class SyncGateway extends Emittery<SyncGatewayEvents> {
  private common: Common;
  private syncStore: SyncStore;
  private networks: Network[];

  // Minimum timestamp at which events are available (across all networks).
  checkpoint: Checkpoint;
  // Minimum finalized timestamp (across all networks).
  finalityCheckpoint: Checkpoint;

  // Per-network event timestamp checkpoints.
  private networkCheckpoints: Record<
    number,
    {
      isHistoricalSyncComplete: boolean;
      historicalCheckpoint: Checkpoint;
      realtimeCheckpoint: Checkpoint;
      finalityCheckpoint: Checkpoint;
    }
  >;

  // Timestamp at which the historical sync was completed (across all networks).
  historicalSyncCompletedAt?: number;

  metrics: SyncGatewayMetrics;

  constructor({
    common,
    syncStore,
    networks,
  }: {
    common: Common;
    syncStore: SyncStore;
    networks: Network[];
  }) {
    super();

    this.common = common;
    this.syncStore = syncStore;
    this.networks = networks;
    this.metrics = {};

    this.checkpoint = zeroCheckpoint;
    this.finalityCheckpoint = zeroCheckpoint;

    this.networkCheckpoints = {};
    this.networks.forEach((network) => {
      const { chainId } = network;
      this.networkCheckpoints[chainId] = {
        isHistoricalSyncComplete: false,
        historicalCheckpoint: zeroCheckpoint,
        realtimeCheckpoint: zeroCheckpoint,
        finalityCheckpoint: zeroCheckpoint,
      };
    });
  }

  /** Fetches events for all registered log filters between the specified checkpoints.
   *
   * @param options.fromCheckpoint Checkpoint to include events from (exclusive).
   * @param options.toCheckpoint Checkpoint to include events to (inclusive).
   */
  async getEvents(
    arg: {
      fromCheckpoint: Checkpoint;
      toCheckpoint: Checkpoint;
      limit: number;
    } & (
      | {
          logFilters: {
            id: string;
            chainId: number;
            criteria: LogFilterCriteria;
            fromBlock?: number;
            toBlock?: number;
            eventSelector: Hex;
          }[];
          factories?: undefined;
        }
      | {
          logFilters?: undefined;
          factories: {
            id: string;
            chainId: number;
            criteria: FactoryCriteria;
            fromBlock?: number;
            toBlock?: number;
            eventSelector: Hex;
          }[];
        }
    ),
  ) {
    const saveRecord = async (res: any) => {
      const record = {
        args: arg,
        res,
      };
      try {
        await mkdir("records");
      } catch (e) {}
      let filename = customRpcClient ? "custom" : "baseline";
      filename = `${filename}_${recordIndex}`;
      filename = `records/${filename}`;
      recordIndex += 1;
      const toWrite = Buffer.from(
        JSON.stringify(record, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
      console.log(`writing ${toWrite.length} bytes to ${recordIndex}`);
      await writeFile(filename, toWrite);
    };

    if (customRpcClient) {
      const res = await callCustomRpc(arg);
      await saveRecord(res);
      return res;
    }
    const res = await this.syncStore.getLogEvents(arg);
    await saveRecord(res);
    return res;
  }

  handleNewHistoricalCheckpoint = (checkpoint: Checkpoint) => {
    const { blockTimestamp, chainId, blockNumber } = checkpoint;

    this.networkCheckpoints[chainId].historicalCheckpoint = checkpoint;

    this.common.logger.trace({
      service: "gateway",
      msg: `New historical checkpoint (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
    });

    this.recalculateCheckpoint();
  };

  handleHistoricalSyncComplete = ({ chainId }: { chainId: number }) => {
    this.networkCheckpoints[chainId].isHistoricalSyncComplete = true;
    this.recalculateCheckpoint();

    // If every network has completed the historical sync, set the metric.
    const networkCheckpoints = Object.values(this.networkCheckpoints);
    if (networkCheckpoints.every((n) => n.isHistoricalSyncComplete)) {
      const maxHistoricalCheckpoint = checkpointMax(
        ...networkCheckpoints.map((n) => n.historicalCheckpoint),
      );
      this.historicalSyncCompletedAt = maxHistoricalCheckpoint.blockTimestamp;

      this.common.logger.debug({
        service: "gateway",
        msg: "Completed historical sync across all networks",
      });
    }
  };

  handleNewRealtimeCheckpoint = (checkpoint: Checkpoint) => {
    const { blockTimestamp, chainId, blockNumber } = checkpoint;

    this.networkCheckpoints[chainId].realtimeCheckpoint = checkpoint;

    this.common.logger.trace({
      service: "gateway",
      msg: `New realtime checkpoint at (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
    });

    this.recalculateCheckpoint();
  };

  handleNewFinalityCheckpoint = (checkpoint: Checkpoint) => {
    const { chainId } = checkpoint;

    this.networkCheckpoints[chainId].finalityCheckpoint = checkpoint;
    this.recalculateFinalityCheckpoint();
  };

  handleReorg = (checkpoint: Checkpoint) => {
    this.emit("reorg", checkpoint);
  };

  /** Resets global checkpoints as well as the network checkpoint for the specified chain ID.
   *  Keeps previous checkpoint values for other networks.
   *
   * @param options.chainId Chain ID for which to reset the checkpoint.
   */
  resetCheckpoints = ({ chainId }: { chainId: number }) => {
    this.checkpoint = zeroCheckpoint;
    this.finalityCheckpoint = zeroCheckpoint;
    this.historicalSyncCompletedAt = 0;
    this.networkCheckpoints[chainId] = {
      isHistoricalSyncComplete: false,
      historicalCheckpoint: zeroCheckpoint,
      realtimeCheckpoint: zeroCheckpoint,
      finalityCheckpoint: zeroCheckpoint,
    };
  };

  private recalculateCheckpoint = () => {
    const checkpoints = Object.values(this.networkCheckpoints).map((n) =>
      n.isHistoricalSyncComplete
        ? checkpointMax(n.historicalCheckpoint, n.realtimeCheckpoint)
        : n.historicalCheckpoint,
    );
    const newCheckpoint = checkpointMin(...checkpoints);

    if (isCheckpointGreaterThan(newCheckpoint, this.checkpoint)) {
      this.checkpoint = newCheckpoint;

      const { chainId, blockTimestamp, blockNumber } = this.checkpoint;
      this.common.logger.trace({
        service: "gateway",
        msg: `New checkpoint (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
      });

      this.emit("newCheckpoint", this.checkpoint);
    }
  };

  private recalculateFinalityCheckpoint = () => {
    const newFinalityCheckpoint = checkpointMin(
      ...Object.values(this.networkCheckpoints).map(
        (n) => n.finalityCheckpoint,
      ),
    );

    if (
      isCheckpointGreaterThan(newFinalityCheckpoint, this.finalityCheckpoint)
    ) {
      this.finalityCheckpoint = newFinalityCheckpoint;

      const { chainId, blockTimestamp, blockNumber } = this.finalityCheckpoint;
      this.common.logger.trace({
        service: "gateway",
        msg: `New finality checkpoint (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
      });

      this.emit("newFinalityCheckpoint", this.finalityCheckpoint);
    }
  };
}
