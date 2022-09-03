import type { GraphQLSchema } from "graphql";

import type { GraphqlApi } from "@/apis/graphql";
import { buildGqlSchema } from "@/apis/graphql/buildGqlSchema";
import {
  generateContextTypes,
  generateContractTypes,
  generateHandlerTypes,
  generateSchema,
  generateSchemaTypes,
} from "@/codegen";
import { handleReindex } from "@/core/indexer/reindex";
import { buildPonderSchema } from "@/core/schema/buildPonderSchema";
import type { EvmSource } from "@/sources/evm";
import type { SqliteStore } from "@/stores/sqlite";

import { Handlers, readHandlers } from "./readHandlers";
import { readPonderConfig } from "./readPonderConfig";
import { readSchema } from "./readSchema";
import { Schema } from "./schema/types";

const state: {
  sources?: EvmSource[];
  api?: GraphqlApi;
  store?: SqliteStore;

  userSchema?: GraphQLSchema;
  schema?: Schema;

  gqlSchema?: GraphQLSchema;
  handlers?: Handlers;
  isIndexingInProgress?: boolean;
} = {};

enum TaskName {
  READ_PONDER_CONFIG,
  // READ_HANDLERS,
  READ_SCHEMA,
  BUILD_GQL_SCHEMA,
  BUILD_PONDER_SCHEMA,
  GENERATE_CONTRACT_TYPES,
  GENERATE_HANDLER_TYPES,
  GENERATE_CONTEXT_TYPES,
  GENERATE_GQL_SCHEMA,
  GENERATE_SCHEMA_TYPES,
  START_APIS,
  REINDEX,
}

type Task = {
  name: TaskName;
  handler: () => Promise<void>;
  dependencies?: TaskName[];
};

export const runTask = async (task: Task) => {
  await task.handler();

  const depTasks = (task.dependencies || []).map((name) => taskMap[name]);
  depTasks.forEach(runTask);
};

export const readPonderConfigTask: Task = {
  name: TaskName.READ_PONDER_CONFIG,
  handler: async () => {
    const { sources, api, store } = await readPonderConfig();

    console.log({ sources, api, store });

    state.sources = sources;
    state.api = api;
    state.store = store;
  },
  dependencies: [
    // TaskName.GENERATE_CONTRACT_TYPES,
    // TaskName.GENERATE_HANDLER_TYPES,
    // TaskName.GENERATE_CONTEXT_TYPES,
    // TaskName.REINDEX,
    TaskName.START_APIS,
  ],
};

// export const readHandlersTask: Task = {
//   name: TaskName.READ_HANDLERS,
//   handler: async () => {
//     state.handlers = await readHandlers();
//   },
//   dependencies: [TaskName.REINDEX],
// };

export const readSchemaTask: Task = {
  name: TaskName.READ_SCHEMA,
  handler: async () => {
    state.userSchema = await readSchema();
  },
  dependencies: [TaskName.BUILD_GQL_SCHEMA, TaskName.BUILD_PONDER_SCHEMA],
};

const buildGqlSchemaTask: Task = {
  name: TaskName.BUILD_GQL_SCHEMA,
  handler: async () => {
    if (state.userSchema) {
      state.gqlSchema = buildGqlSchema(state.userSchema);
    }
  },
  dependencies: [
    TaskName.GENERATE_GQL_SCHEMA,
    TaskName.GENERATE_SCHEMA_TYPES,
    TaskName.GENERATE_CONTRACT_TYPES,
    TaskName.START_APIS,
  ],
};

const buildPonderSchemaTask: Task = {
  name: TaskName.BUILD_PONDER_SCHEMA,
  handler: async () => {
    if (state.userSchema) {
      state.schema = buildPonderSchema(state.userSchema);
    }
  },
  dependencies: [TaskName.GENERATE_CONTEXT_TYPES, TaskName.REINDEX],
};

const generateContractTypesTask: Task = {
  name: TaskName.GENERATE_CONTRACT_TYPES,
  handler: async () => {
    if (state.sources) {
      await generateContractTypes(state.sources);
    }
  },
};

const generateHandlerTypesTask: Task = {
  name: TaskName.GENERATE_HANDLER_TYPES,
  handler: async () => {
    if (state.sources) {
      await generateHandlerTypes(state.sources);
    }
  },
};

const generateContextTypesTask: Task = {
  name: TaskName.GENERATE_CONTEXT_TYPES,
  handler: async () => {
    if (state.sources && state.schema) {
      await generateContextTypes(state.sources, state.schema);
    }
  },
};

const generateGqlSchemaTask: Task = {
  name: TaskName.GENERATE_GQL_SCHEMA,
  handler: async () => {
    if (state.gqlSchema) {
      await generateSchema(state.gqlSchema);
    }
  },
};

const generateSchemaTypesTask: Task = {
  name: TaskName.GENERATE_SCHEMA_TYPES,
  handler: async () => {
    if (state.gqlSchema) {
      await generateSchemaTypes(state.gqlSchema);
    }
  },
  // NOTE: After adding enum support, could no longer import
  // the user handlers module before the entity types are generated
  // because esbuild cannot strip enum imports (they are values).
  // TODO: Find a better / more reasonable dependency path here.
  // dependencies: [TaskName.READ_HANDLERS],
};

const reindexTask: Task = {
  name: TaskName.REINDEX,
  handler: async () => {
    if (!state.sources || !state.schema || !state.handlers) {
      return;
    }

    // // TODO: Use actual DB transactions to handle this. That way, can stop
    // // in-flight indexing job by rolling back txn and then start new.
    // if (state.isIndexingInProgress) return;

    // state.isIndexingInProgress = true;
    // await handleReindex(state.config, state.schema, state.handlers);
    // state.isIndexingInProgress = false;
  },
};

const startApisTask: Task = {
  name: TaskName.START_APIS,
  handler: async () => {
    if (state.api && state.gqlSchema) {
      state.api.start(state.gqlSchema);
    }
  },
};

const taskMap: Record<TaskName, Task> = {
  [TaskName.READ_PONDER_CONFIG]: readPonderConfigTask,
  // [TaskName.READ_HANDLERS]: updateUserHandlersTask,
  [TaskName.READ_SCHEMA]: readSchemaTask,
  [TaskName.BUILD_GQL_SCHEMA]: buildGqlSchemaTask,
  [TaskName.BUILD_PONDER_SCHEMA]: buildPonderSchemaTask,
  [TaskName.GENERATE_CONTRACT_TYPES]: generateContractTypesTask,
  [TaskName.GENERATE_HANDLER_TYPES]: generateHandlerTypesTask,
  [TaskName.GENERATE_CONTEXT_TYPES]: generateContextTypesTask,
  [TaskName.GENERATE_GQL_SCHEMA]: generateGqlSchemaTask,
  [TaskName.GENERATE_SCHEMA_TYPES]: generateSchemaTypesTask,
  [TaskName.REINDEX]: reindexTask,
  [TaskName.START_APIS]: startApisTask,
};