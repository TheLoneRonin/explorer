import React from "react";
import * as Sentry from "@sentry/react";
import {
  PublicKey,
  TransactionError,
  ConfirmedSignatureInfo,
  TransactionSignature,
  Connection,
} from "@solana/web3.js";
import { RetrieveAccount } from '@theronin/solarweave';
import { useCluster, Cluster } from "../cluster";
import * as Cache from "providers/cache";
import { ActionType, FetchStatus } from "providers/cache";

export const SolarweaveDatabase = 'solarweave-cache-devnet-testrun4-index';

interface FetchedInformation extends ConfirmedSignatureInfo {
  cursor: string;
}

type AccountHistory = {
  fetched: FetchedInformation[];
  foundOldest: boolean;
};

type HistoryUpdate = {
  history?: AccountHistory;
  before?: TransactionSignature;
};

type State = Cache.State<AccountHistory>;
type Dispatch = Cache.Dispatch<HistoryUpdate>;

function combineFetched(
  fetched: FetchedInformation[],
  current: FetchedInformation[] | undefined,
  before: string | undefined
) {
  if (current === undefined) {
    return fetched;
  }

  if (current.length > 0 && current[current.length - 1].cursor === before) {
    return current.concat(fetched);
  } else {
    return fetched;
  }
}

function reconcile(
  history: AccountHistory | undefined,
  update: HistoryUpdate | undefined
) {
  if (update?.history === undefined) return history;
  return {
    fetched: combineFetched(
      update.history.fetched,
      history?.fetched,
      update?.before
    ),
    foundOldest: update?.history?.foundOldest || history?.foundOldest || false,
  };
}

const StateContext = React.createContext<State | undefined>(undefined);
const DispatchContext = React.createContext<Dispatch | undefined>(undefined);

type HistoryProviderProps = { children: React.ReactNode };
export function HistoryProvider({ children }: HistoryProviderProps) {
  const { url } = useCluster();
  const [state, dispatch] = Cache.useCustomReducer(url, reconcile);

  React.useEffect(() => {
    dispatch({ type: ActionType.Clear, url });
  }, [dispatch, url]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

async function fetchAccountHistory(
  dispatch: Dispatch,
  pubkey: PublicKey,
  cluster: Cluster,
  url: string,
  options: { before?: string; start?: number; limit: number }
) {
  dispatch({
    type: ActionType.Update,
    status: FetchStatus.Fetching,
    key: pubkey.toBase58(),
    url,
  });

  let status;
  let history;
  
  try {
    const startingIndex = options.start ? options.start : 0;
    const fetched = [];
    const Blocks = await RetrieveAccount(pubkey.toString(), options.limit, options.before ? options.before : '', SolarweaveDatabase);

    for (let i = 0; i < Blocks.length; i++) {
      const Block = Blocks[i];
      const tags: any = {};

      for (let ii = 0; ii < Block.node.tags.length; ii++) {
        const tag = Block.node.tags[ii];
        tags[tag.name] = tag.value;
      }

      fetched.push({
        err: null,
        memo: null,
        signature: tags.defaultSignature ? tags.defaultSignature : '',
        slot: tags.slot ? Number(tags.slot) : -1,
        cursor: Block.cursor,
      });
    }
    
    history = {
      fetched,
      foundOldest: fetched.length < options.limit,
    };

    status = FetchStatus.Fetched;
  } catch (error) {
    console.log(error);
    if (cluster !== Cluster.Custom) {
      // Sentry.captureException(error, { tags: { url } });
    }
    status = FetchStatus.FetchFailed;
  }

  dispatch({
    type: ActionType.Update,
    url,
    key: pubkey.toBase58(),
    status,
    data: {
      history,
      before: options?.before,
    },
  });
}

export function useAccountHistories() {
  const context = React.useContext(StateContext);

  if (!context) {
    throw new Error(
      `useAccountHistories must be used within a AccountsProvider`
    );
  }

  return context.entries;
}

export function useAccountHistory(
  address: string
): Cache.CacheEntry<AccountHistory> | undefined {
  const context = React.useContext(StateContext);

  if (!context) {
    throw new Error(`useAccountHistory must be used within a AccountsProvider`);
  }

  return context.entries[address];
}

export function useFetchAccountHistory() {
  const { cluster, url } = useCluster();
  const state = React.useContext(StateContext);
  const dispatch = React.useContext(DispatchContext);
  if (!state || !dispatch) {
    throw new Error(
      `useFetchAccountHistory must be used within a AccountsProvider`
    );
  }

  return React.useCallback((pubkey: PublicKey, refresh?: boolean) => {
      const before = state.entries[pubkey.toBase58()];

      if (!refresh && before?.data?.fetched && before.data.fetched.length > 0) {
        if (before.data.foundOldest) return;
        const lastCursor = before.data.fetched[before.data.fetched.length - 1].cursor;
        fetchAccountHistory(dispatch, pubkey, cluster, url, {
          before: lastCursor,
          start: before.data.fetched.length,
          limit: 5,
        });
      } else {
        fetchAccountHistory(dispatch, pubkey, cluster, url, { limit: 5 });
      }
    },
    [state, dispatch, cluster, url]
  );
}
