// @flow

import Url from 'url-parse';
import { memoize } from 'lodash';
import Protector from 'libp2p-pnet';
import request from 'request';
import PQueue from 'p-queue';
import XhrLoader from 'hls.js/src/utils/xhr-loader';
import LruCache from 'lru-cache';

class BoltUrlError extends Error {}

class BoltIpfsError extends Error {}

const isIE = /MSIE \d|Trident.*rv:/.test(navigator.userAgent);

const getBoltOriginPath = memoize((url:string) => {
  const parsed = new URL(url);
  return `origin/${parsed.hostname}${parsed.port && parsed.port !== '443' && parsed.port !== '80' ? `:${parsed.port}` : ''}${parsed.pathname}${parsed.search ? `${parsed.search}` : ''}`;
});

class BoltLoader extends XhrLoader {
  load(context, config, callbacks) {
    const boltClient = this.constructor.boltClient;
    let { url, responseType } = context;
    if (url.indexOf('origin/') === -1) {
      const originPath = getBoltOriginPath(url);
      url = context.url = boltClient.getUrl(originPath); // eslint-disable-line no-param-reassign
    }
    const parsed = new URL(url);
    const path = `${parsed.pathname.slice(1)}${parsed.search ? `${parsed.search}` : ''}`;
    const hlsLocalFilePromise = boltClient.hlsLocalFiles.get(path);
    const { onSuccess } = callbacks;
    if (hlsLocalFilePromise) {
      console.log('HIT', path);
      const start = performance.now();
      hlsLocalFilePromise.then((hlsLocalFile) => {
        const now = performance.now();
        let data;
        let length;
        boltClient.ipfsBytes += hlsLocalFile.byteLength;
        if (responseType === 'arraybuffer') {
          data = hlsLocalFile;
          length = hlsLocalFile.byteLength;
        } else {
          data = Buffer.from(hlsLocalFile).toString('utf8');
          length = data.length;
        }
        onSuccess({
          url,
          data,
        }, {
          trequest: start,
          tfirst: start,
          tload: now,
          loaded: length,
          total: length,
          retry: 0,
        }, context, boltClient);
      }).catch((error) => {
        console.log('ERROR', error);
      });
      return;
    }
    console.log('MISS', path);

    callbacks.onSuccess = (response, stats, context, xhr) => {
      boltClient.proxyBytes += stats.total;
      onSuccess(response, stats, context, xhr);
    };
    super.load(context, config, callbacks);
  }
}

class BoltPlaylistLoader extends BoltLoader {
  load(context, config, callbacks) {
    super.load(context, config, callbacks);
    const boltClient = this.constructor.boltClient;
    const url = context.url;
    const parsed = new URL(url);
    try {
      boltClient.updateHlsSubscriptions(`${parsed.pathname.slice(1)}${parsed.search ? `${parsed.search}` : ''}`);
    } catch (error) {
      console.error(error);
    }
  }
}

/**
 * Class representing a Bolt Client
 */
export class BoltClient {
  baseUrls: Set<string>;
  ipfs: Object;
  idPromise:Promise<string>;
  ipfsReady: Promise<void>;
  swarmKey: string;
  ready: Promise<void>;
  readyCallback: () => void;
  addToSwarmQueue: PQueue;
  mostRecentBaseUrl: string;
  hlsSubscriptionHandlers: Map<string, ({ data:Buffer }) => Promise<void>>;
  hlsSubscriptionTimeouts: Map<string, TimeoutID>;
  hlsLocalFiles: LruCache;
  hlsJsFLoader:Object;
  hlsJsPLoader:Object;
  proxyBytes: number;
  ipfsBytes: number;

  constructor() {
    this.baseUrls = new Set();
    this.addToSwarmQueue = new PQueue({ concurrency: 1 });
    this.ready = new Promise((resolve) => {
      this.readyCallback = () => resolve();
    });
    const serverAddressesString = localStorage.getItem('BOLT_SERVER_ADDRESSES');
    if (serverAddressesString) {
      try {
        const serverAddresses = JSON.parse(serverAddressesString);
        if (serverAddresses.length > 0) {
          console.log('Stored Bolt server addresses:');
        }
        for (const serverAddress of serverAddresses) {
          console.log(`\t${serverAddress}`);
          this.addServer(serverAddress);
        }
      } catch (error) {
        console.log('Unable to parse stored Bolt server addresses');
        console.error(error);
        localStorage.removeItem('BOLT_SERVER_ADDRESSES');
      }
    }
    let activePeerCount = 0;
    setInterval(() => {
      if (this.ipfs) {
        this.ipfs.swarm.peers({ verbose: true }).then((peerInfos) => {
          if (peerInfos.length !== activePeerCount) {
            activePeerCount = peerInfos.length;
            if (peerInfos.length === 0) {
              console.log('No connected peers');
            } else {
              console.log('Connected peers:');
              for (const { addr } of peerInfos) {
                console.log(`\t${addr}`);
              }
            }
          }
        }).catch((error) => {
          console.log('Unable to get Bolt peers');
          console.error(error);
        });
      }
    }, 10000);
    setInterval(async () => {
      console.log(`Proxy: ${Math.round(this.proxyBytes / 10485.76) / 1000} MB`);
      console.log(`P2P: ${Math.round(this.ipfsBytes / 10485.76) / 1000} MB`);
      const peers = await this.ipfs.swarm.peers();
      let websocketInBytes = 0;
      let webRtcInBytes = 0;
      let websocketOutBytes = 0;
      let webRtcOutBytes = 0;
      for (const { addr, peer } of peers) {
        const { totalIn, totalOut } = await this.ipfs.stats.bw({ peer: peer.toB58String() });
        if (addr.toString().indexOf('webrtc') !== -1) {
          webRtcInBytes += totalIn.toNumber();
          webRtcOutBytes += totalOut.toNumber();
        } else {
          websocketInBytes += totalIn.toNumber();
          websocketOutBytes += totalOut.toNumber();
        }
      }
      console.log(`Websocket: ${Math.round(websocketInBytes / 10485.76) / 1000} MB In, ${Math.round(websocketOutBytes / 10485.76) / 1000} MB Out`);
      console.log(`WebRTC: ${Math.round(webRtcInBytes / 10485.76) / 1000} MB In, ${Math.round(webRtcOutBytes / 10485.76) / 1000} MB Out`);
    }, 10000);
    const boltClient = this;
    class FLoader extends BoltLoader {
      static boltClient = boltClient;
    }
    class PLoader extends BoltPlaylistLoader {
      static boltClient = boltClient;
    }
    this.hlsJsFLoader = FLoader;
    this.hlsJsPLoader = PLoader;
    this.hlsSubscriptionHandlers = new Map();
    this.hlsSubscriptionTimeouts = new Map();
    this.hlsLocalFiles = new LruCache({ max: 10 });
    this.proxyBytes = 0;
    this.ipfsBytes = 0;
  }

  addServer(s:string) {
    const { protocol, slashes, username, password, hostname, port } = new Url(s);
    const result = [protocol || 'https:'];
    if (protocol && protocol.charAt(protocol.length - 1) !== ':') {
      result.push(':');
    }
    if (slashes) {
      result.push('//');
    }
    if (username) {
      result.push(username);
      if (password) {
        result.push(`:${password}`);
      }
      result.push('@');
    }
    result.push(hostname);
    result.push(port || (protocol === 'https:' ? ':443' : ':80'));
    const baseUrl = result.join('');
    this.mostRecentBaseUrl = baseUrl;
    if (this.baseUrls.has(baseUrl)) {
      return;
    }
    this.baseUrls.add(baseUrl);
    this.saveServerAddresses();
    this.addToSwarm(baseUrl);
    this.readyCallback();
  }

  saveServerAddresses() {
    localStorage.setItem('BOLT_SERVER_ADDRESSES', JSON.stringify([...this.baseUrls]));
  }

  getUrl(path:string) {
    if (this.baseUrls.size === 0) {
      const { mostRecentBaseUrl } = this;
      if (!mostRecentBaseUrl) {
        throw new BoltUrlError('No base URLs');
      }
      return mostRecentBaseUrl;
    }
    const baseUrls = Array.from(this.baseUrls);
    const baseUrl = baseUrls[Math.floor(Math.random() * baseUrls.length)];
    return `${baseUrl}/${path}`;
  }

  async queryForPeers(baseUrl:string) {
    const { protocol, port } = new Url(baseUrl);
    const peerHostnames = await new Promise((resolve, reject) => {
      request.get(`${baseUrl}/api/1.0/network-map/hostnames`, (error, response, body) => {
        if (error) {
          this.clearSwarmSettings(baseUrl);
          this.baseUrls.delete(baseUrl);
          this.saveServerAddresses();
          reject(error);
        } else {
          try {
            resolve(JSON.parse(body));
          } catch (parseError) {
            this.clearSwarmSettings(baseUrl);
            this.baseUrls.delete(baseUrl);
            this.saveServerAddresses();
            reject(parseError);
          }
        }
      });
    });
    const peerUrls = new Set();
    for (const peerHostname of peerHostnames) {
      peerUrls.add(`${protocol}//${peerHostname}:${port || (protocol === 'https:' ? '443' : '80')}`);
    }
    const newUrls = [...peerUrls].filter((url) => !this.baseUrls.has(url));
    const oldUrls = [...this.baseUrls].filter((url) => !peerUrls.has(url));
    if (newUrls.length === 0) {
      return;
    }
    for (const url of oldUrls) {
      this.baseUrls.delete(url);
    }
    for (const url of newUrls) {
      this.addServer(url);
    }
  }

  clearSwarmSettings(baseUrl:string) {
    const localStorageKey = `${baseUrl}:BOLT_SWARM_SETTINGS`;
    localStorage.removeItem(localStorageKey);
  }

  async getSwarmSettings(baseUrl:string) {
    const localStorageKey = `${baseUrl}:BOLT_SWARM_SETTINGS`;
    const storedSwarmSettingsString = localStorage.getItem(localStorageKey);
    if (storedSwarmSettingsString) {
      try {
        return JSON.parse(storedSwarmSettingsString);
      } catch (error) {
        console.log('Unable to parse stored Bolt settings');
        console.error(error);
        localStorage.removeItem(localStorageKey);
      }
    }
    const swarmSettings = await new Promise((resolve, reject) => {
      request.get(`${baseUrl}/api/1.0/swarm`, (error, response, body) => {
        if (error) {
          this.clearSwarmSettings(baseUrl);
          this.baseUrls.delete(baseUrl);
          this.saveServerAddresses();
          reject(error);
        } else {
          try {
            resolve(JSON.parse(body));
          } catch (parseError) {
            this.clearSwarmSettings(baseUrl);
            this.baseUrls.delete(baseUrl);
            this.saveServerAddresses();
            reject(parseError);
          }
        }
      });
    });
    localStorage.setItem(localStorageKey, JSON.stringify(swarmSettings));
    return swarmSettings;
  }

  async getIpfs() {
    for (let i = 0; i < 10; i += 1) {
      if (window) {
        const { Ipfs } = window;
        if (Ipfs) {
          return Ipfs;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100)); // eslint-disable-line no-loop-func
    }
    let j = 0;
    while (true) {
      j += 1;
      if (window) {
        const { Ipfs } = window;
        if (Ipfs) {
          return Ipfs;
        }
      }
      if (j < 8) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * j * j)); // eslint-disable-line no-loop-func
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 60)); // eslint-disable-line no-loop-func
      }
    }
    throw new Error('Unable to load IPFS'); // eslint-disable-line no-unreachable
  }

  async restartIpfs() {
    const ipfsReady = this.ipfsReady;
    if (ipfsReady) {
      try {
        await ipfsReady;
      } catch (error) {
        console.log('IPFS failed to start before restart process, continuing');
      }
    }
    const ipfs = this.ipfs;
    delete this.ipfs;
    if (ipfs) {
      console.log('Restarting IPFS');
      await ipfs.stop();
    }
    this.startIpfs();
  }

  startIpfs() {
    if (isIE) {
      throw new Error('IPFS not supported in IE');
    }
    if (this.ipfsReady) {
      return this.ipfsReady;
    }
    const ipfsReady = this._startIpfs(); // eslint-disable-line no-underscore-dangle
    ipfsReady.then(() => {
      delete this.ipfsReady;
    }).catch(() => {
      delete this.ipfsReady;
    });
    this.ipfsReady = ipfsReady;
    return ipfsReady;
  }

  async addToSwarm(baseUrl:string) {
    return this.addToSwarmQueue.add(() => this._addToSwarm(baseUrl)); // eslint-disable-line no-underscore-dangle
  }

  async _addToSwarm(baseUrl:string, attempt?:number = 1) {
    try {
      const { id, swarmKey } = await this.getSwarmSettings(baseUrl);
      if (this.swarmKey && swarmKey !== this.swarmKey && this.mostRecentBaseUrl) {
        // Restart if swarm keys don't match
        this.clearSwarmSettings(baseUrl);
        this.addToSwarmQueue.clear();
        this.baseUrls = new Set();
        this.saveServerAddresses();
        this.addServer(this.mostRecentBaseUrl);
        this.restartIpfs();
        return;
      }
      if (!swarmKey) {
        throw new BoltIpfsError('Unable to fetch swarm key');
      }
      if (!this.swarmKey) {
        try {
          await this.queryForPeers(baseUrl);
        } catch (error) {
          console.log(`Unable to query ${baseUrl} for Bolt peers: ${error.message}`);
        }
      }
      this.swarmKey = swarmKey;
      const { protocol, host, port } = new Url(baseUrl);
      const wrtcPort = port || (protocol === 'https:' ? 443 : 80);
      const wrtcProtocol = protocol === 'https:' ? 'wss' : 'ws';
      const ipfsReady = this.ipfsReady;
      if (ipfsReady) {
        try {
          await ipfsReady;
        } catch (error) {
          console.log(`IPFS failed to start before adding ${baseUrl} to swarm, continuing`);
        }
      }
      if (this.ipfsReady) {
        return;
      }
      const ipfs = this.ipfs;
      if (!ipfs) {
        return;
      }
      const multiaddr = `/dns4/${host}/tcp/${wrtcPort}/${wrtcProtocol}/ipfs/${id}`;
      console.log(`Connecting to ${multiaddr}`);
      await ipfs.swarm.connect(multiaddr);
    } catch (error) {
      this.clearSwarmSettings(baseUrl);
      if (attempt < 5) {
        console.log(`Unable to get Bolt settings from ${baseUrl}, retrying in ${attempt * attempt} seconds`);
        console.error(error);
        await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 1000));
        await this._addToSwarm(baseUrl, attempt + 1); // eslint-disable-line no-underscore-dangle
        return;
      }
      console.log(`Unable to get Bolt settings from ${baseUrl}`);
      console.error(error);
    }
  }

  async _startIpfs() {
    if (this.ipfs) {
      throw new BoltIpfsError('IPFS already started');
    }
    if (this.baseUrls.size === 0) {
      throw new BoltUrlError('No base URLs');
    }
    let swarmKey;
    let clusterId;
    let swarmAddresses = [];
    const bootstrap = [];
    for (const baseUrl of this.baseUrls) {
      const { protocol, host, port } = new Url(baseUrl);
      const wrtcPort = port || (protocol === 'https:' ? 443 : 80);
      const wrtcProtocol = protocol === 'https:' ? 'wss' : 'ws';
      try {
        const swarmSettings = await this.getSwarmSettings(baseUrl);
        if (swarmKey && swarmKey !== swarmSettings.swarmKey && this.mostRecentBaseUrl) {
          // Restart if swarm keys don't match
          this.addToSwarmQueue.clear();
          this.baseUrls = new Set();
          this.saveServerAddresses();
          this.addServer(this.mostRecentBaseUrl);
          this.restartIpfs();
          return;
        }
        swarmKey = swarmSettings.swarmKey;
        clusterId = swarmSettings.clusterId;
        if (swarmAddresses.length === 0) {
          swarmAddresses = [`/dns4/${host}/tcp/${wrtcPort}/${wrtcProtocol}/p2p-webrtc-star`];
        }
        bootstrap.push(`/dns4/${host}/tcp/${wrtcPort}/${wrtcProtocol}/ipfs/${swarmSettings.id}`);
      } catch (error) {
        console.log(`Unable to get Bolt settings from ${baseUrl}`);
        console.error(error);
      }
    }
    if (!swarmKey) {
      throw new BoltIpfsError('Unable to fetch swarm key');
    }
    if (!clusterId) {
      throw new BoltIpfsError('Unable to fetch cluster ID');
    }
    this.swarmKey = swarmKey;
    const IPFS = await this.getIpfs();
    const config = {
      repo: 'bolt',
      preload: {
        enabled: false,
      },
      relay: {
        enabled: false,
        hop: {
          enabled: true,
          active: true,
        },
      },
      EXPERIMENTAL: {
        sharding: true,
        dht: true,
      },
      libp2p: {
        modules: {
          connProtector: new Protector(swarmKey),
        },
        config: {
          dht: {
            enabled: false,
          },
        },
      },
      config: {
        Addresses: {
          Swarm: swarmAddresses,
        },
        Bootstrap: bootstrap,
      },
    };
    const ipfs = new IPFS(config);
    ipfs.on('error', (error) => {
      console.log('IPFS error:');
      console.error(error);
    });
    await new Promise((resolve, reject) => {
      const handleReady = () => {
        ipfs.removeListener('ready', handleReady);
        ipfs.removeListener('error', handleError);
        resolve();
      };
      const handleError = (error) => {
        ipfs.removeListener('ready', handleReady);
        ipfs.removeListener('error', handleError);
        reject(error);
      };
      ipfs.on('ready', handleReady);
      ipfs.on('error', handleError);
    });
    this.idPromise = ipfs.id().then((ipfsResponse) => ipfsResponse.id);
    this.ipfs = ipfs;
    this.runGarbageCollection();
    // $FlowFixMe
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      setInterval(() => {
        this.runGarbageCollection();
      }, 60 * 1000);
    } else {
      setInterval(() => {
        this.runGarbageCollection();
      }, 60 * 60 * 1000);
    }
  }

  updateHlsSubscriptions(path:string) {
    const ipfs = this.ipfs;
    if (!ipfs) {
      console.log('NO IPFS');
      return;
    }
    if (!this.hlsSubscriptionHandlers.has(path)) {
      const handler = async ({ data }) => {
        const [item, hash, expires] = JSON.parse(data.toString());
        const maxAge = expires ? expires - Date.now() : undefined;
        if (maxAge < 0) {
          return;
        }
        this.hlsLocalFiles.set(item, ipfs.cat(hash), maxAge);
      };
      this.hlsSubscriptionHandlers.set(path, handler);
      ipfs.pubsub.subscribe(`${path}:files`, handler).catch((error) => {
        console.error(error);
      });
    }
    const timeout = this.hlsSubscriptionTimeouts.get(path);
    clearTimeout(timeout);
    this.hlsSubscriptionTimeouts.set(path, setTimeout(() => {
      const handler = this.hlsSubscriptionHandlers.get(path);
      if (handler) {
        ipfs.pubsub.unsubscribe(`${path}:files`, handler).catch((error) => {
          console.error(error);
        });
      }
      this.hlsSubscriptionHandlers.delete(path);
      this.hlsSubscriptionTimeouts.delete(path);
    }, 30000));
  }

  async runGarbageCollection() {
    const ipfs = this.ipfs;
    if (!ipfs) {
      return;
    }
    // $FlowFixMe
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      // $FlowFixMe
      const { usage, quota } = await navigator.storage.estimate();
      console.log(`Using ${Math.round(10000 * usage / quota) / 100}% of ${Math.round(100 * quota / 1024 / 1024 / 1024) / 100} GB storage quota`);
      if (usage < 5368709120 && (usage / quota) < 0.5) {
        return;
      }
    }
    console.log('Running IPFS garbage collection');
    try {
      await ipfs.repo.gc();
    } catch (error) {
      console.log('Unable to run IPFS garbage collection');
      console.error(error);
    }
  }
}

const bc = new BoltClient();

if (window) {
  window.boltClient = bc;
}

export default bc;
