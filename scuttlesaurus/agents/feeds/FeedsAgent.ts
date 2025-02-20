import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  computeMsgHash,
  delay,
  FeedId,
  fromBase64,
  JSONValue,
  log,
  NotFoundError,
  ObservableSet,
  parseFeedId,
  sodium,
  toBase64,
} from "../../util.ts";
import Agent from "../Agent.ts";
import FeedsStorage from "../../storage/FeedsStorage.ts";
import ConnectionManager from "../ConnectionManager.ts";

const textEncoder = new TextEncoder();

export type MessageValue = JSONValue & {
  sequence: number;
  author: string;
  signature: string;
  previous: string | null;
  content: JSONValue;
};

export type Message = {
  value: MessageValue;
  key: string;
};

export default class FeedsAgent extends Agent {
  constructor(
    public feedsStorage: FeedsStorage,
    public subscriptions: ObservableSet<FeedId>,
    public peers: ObservableSet<Address>,
  ) {
    super();
  }

  createRpcContext(_feedId: FeedId): RpcContext {
    // deno-lint-ignore no-this-alias
    const agent = this;
    const rpcMethods = {
      createHistoryStream: async function* (args: Record<string, string>[]) {
        const opts = args[0];
        const feedId = parseFeedId(opts.id);
        const live = (typeof (opts.live) === "undefined")
          ? false
          : JSON.parse(opts.live);
        const old = (typeof (opts.old) === "undefined")
          ? true
          : JSON.parse(opts.old);
        const keys = (typeof (opts.keys) === "undefined")
          ? true
          : JSON.parse(opts.old);
        const seq = (typeof (opts.seq) === "undefined")
          ? 1
          : Number.parseInt(opts.seq);
        for await (
          const msg of agent.getFeed(feedId, {
            fromMessage: old ? seq : 0,
            newMessages: live,
          })
        ) {
          if (keys) {
            yield msg;
          } else {
            yield msg.value;
          }
        }
      },
    };
    return rpcMethods;
  }

  /** contains the adress strings of ongoing sync partners */
  private onGoingSyncPeers = new Map<string, RpcConnection>();

  async incomingConnection(rpcConnection: RpcConnection) {
    this.updateFeed(
      rpcConnection,
      rpcConnection.boxConnection.peer,
    );
    const peerStr = rpcConnection.boxConnection.peer.base64Key;
    if (!this.onGoingSyncPeers.has(peerStr)) {
      this.onGoingSyncPeers.set(peerStr, rpcConnection);
      try {
        await this.updateFeeds(rpcConnection);
      } finally {
        this.onGoingSyncPeers.delete(peerStr);
      }
    }
  }

  outgoingConnection = this.incomingConnection;

  private async pickPeer(): Promise<Address> {
    //The maximum is exclusive and the minimum is inclusive
    function getRandomInt(min: number, max: number) {
      return Math.floor(Math.random() * (max - min) + min);
    }
    if (this.peers.size === 0) {
      console.warn("No peer known.");
      //return the first we get
      return await new Promise((resolve) => {
        const listener = (addr: Address) => {
          this.peers.removeAddListener(listener);
          resolve(addr);
        };
        this.peers.addAddListener(listener);
      });
    } else {
      return [...this.peers][getRandomInt(0, this.peers.size)];
    }
  }

  async run(connector: ConnectionManager): Promise<void> {
    const onGoingConnectionAttempts = new Set<string>();
    this.subscriptions.addAddListener(async (feedId) => {
      for (const connection of this.onGoingSyncPeers.values()) {
        await this.updateFeed(connection, feedId);
      }
    });
    while (true) {
      const pickedPeer = await this.pickPeer();
      const pickedPeerStr = pickedPeer.key.base64Key;
      if (!onGoingConnectionAttempts.has(pickedPeerStr)) {
        onGoingConnectionAttempts.add(pickedPeerStr);
        (async () => {
          try {
            //this will cause `outgoingConnection` to be invoked
            await connector.getConnectionWith(pickedPeer);
          } catch (error) {
            log.error(
              `In connection with ${pickedPeer}: ${error}`,
            );
            //TODO this shoul cause this peer to be attempted less frequently
          }
        })().finally(() => {
          onGoingConnectionAttempts.delete(pickedPeerStr);
        });
      }
      // wait some time depending on how many syncs are going on
      await delay((this.onGoingSyncPeers.size * 10 + 1) * 1000);
    }
  }

  private newMessageListeners: Array<(feedId: FeedId, msg: Message) => void> =
    [];

  addNewMessageListeners(listener: (feedId: FeedId, msg: Message) => void) {
    this.newMessageListeners.push(listener);
  }

  removeNewMessageListeners(listener: (feedId: FeedId, msg: Message) => void) {
    this.newMessageListeners.splice(
      this.newMessageListeners.indexOf(listener),
      1,
    );
  }

  fireNewMessageEvent(feedKey: FeedId, msg: Message) {
    this.newMessageListeners.forEach((listener) => listener(feedKey, msg));
  }

  async *getFeed(feedId: FeedId, {
    /** negative numbers are relative to the latest message, 0 means no existing message,
     * positive numbers indicate the index of the oldest message to be returned */
    fromMessage = -10,
    newMessages = true,
  }: { fromMessage?: number; newMessages?: boolean } = {}): AsyncIterable<
    Message
  > {
    if (fromMessage != 0) {
      const lastMessage = await this.feedsStorage.lastMessage(feedId);
      fromMessage = fromMessage > 0
        ? fromMessage
        : lastMessage + fromMessage + 1;
      if (fromMessage < 1) {
        fromMessage = 1;
      }
      for (let pos = fromMessage; pos <= lastMessage; pos++) {
        try {
          yield this.feedsStorage.getMessage(
            feedId,
            pos,
          );
        } catch (error) {
          if (error instanceof NotFoundError) {
            log.info(
              `Message ${pos} of ${feedId} not found`,
            );
          }
        }
      }
    }
    if (newMessages) {
      let resolver: (msg: Message) => void;
      const listener = (
        msgFeedId: FeedId,
        msg: Message,
      ) => {
        if (feedId.base64Key === msgFeedId.base64Key) {
          resolver(msg);
        }
      };
      this.addNewMessageListeners(listener);
      try {
        while (true) {
          yield await new Promise<Message>((resolve) => {
            resolver = resolve;
          });
        }
      } finally {
        this.removeNewMessageListeners(listener);
      }
    }
  }

  async updateFeed(
    rpcConnection: RpcConnection,
    feedKey: FeedId,
  ) {
    const messagesAlreadyHere = await this.feedsStorage.lastMessage(feedKey);
    try {
      await this.updateFeedFrom(
        rpcConnection,
        feedKey,
        messagesAlreadyHere + 1,
      );
    } catch (error) {
      log.info(`error updating feed ${feedKey}: ${error}`);
    }
  }

  private async updateFeedFrom(
    rpcConnection: RpcConnection,
    feedKey: FeedId,
    from: number,
  ) {
    log.debug(`Updating Feed ${feedKey} from ${from}`);
    const historyStream = await rpcConnection.sendSourceRequest({
      "name": ["createHistoryStream"],
      "args": [{
        "id": feedKey.toString(),
        "seq": from,
        "live": true,
      }],
    }) as AsyncIterable<Message>;
    let expectedSequence = from;
    for await (const msg of historyStream) {
      if (expectedSequence !== msg.value.sequence) {
        throw new Error(
          `Expected sequence ${expectedSequence} but got ${msg.value.sequence}`,
        );
      }
      expectedSequence++;
      const hash = computeMsgHash(msg.value);
      const key = `%${toBase64(hash)}.sha256`;
      if (key !== msg.key) {
        throw new Error(
          "Computed hash doesn't match key " +
            JSON.stringify(msg, undefined, 2),
        );
      }
      if (
        !verifySignature(msg.value)
      ) {
        throw Error(
          `failed to verify signature of the message: ${
            JSON.stringify(msg.value, undefined, 2)
          }`,
        );
      }
      if (msg.value.sequence > 1) {
        const previousMessage = await this.feedsStorage.getMessage(
          feedKey,
          msg.value.sequence - 1,
        );
        if (previousMessage.key !== msg.value.previous) {
          throw new Error(
            `Broken Crypto-Chain in ${feedKey} at ${msg.value.sequence}`,
          );
        }
      }

      try {
        await this.feedsStorage.storeMessage(
          feedKey,
          msg.value.sequence,
          msg,
        );
        this.fireNewMessageEvent(feedKey, msg);
      } catch (e) {
        log.debug(`Storing message: ${e}`);
      }
    }
    log.debug(() => `Stream ended for feed ${feedKey}`);
  }

  private updateFeeds(rpcConnection: RpcConnection) {
    const subscriptions = this.subscriptions;
    return Promise.all(
      [...subscriptions].map((feed) => this.updateFeed(rpcConnection, feed)),
    );
  }
}

export function verifySignature(msg: { author: string; signature?: string }) {
  if (!msg.signature) {
    throw Error("no signature in messages");
  }
  const signatureString = msg.signature;
  const signature = fromBase64(
    signatureString.substring(
      0,
      signatureString.length - ".sig.ed25519".length,
    ),
  );
  const authorsPubkicKey = fromBase64(
    msg.author.substring(1, msg.author.length - ".ed25519".length),
  );
  delete msg.signature;
  const verifyResult = sodium.crypto_sign_verify_detached(
    signature,
    textEncoder.encode(JSON.stringify(msg, undefined, 2)),
    authorsPubkicKey,
  );
  msg.signature = signatureString;
  return verifyResult;
}
