// @flow

import Url from 'url-parse';
import Protector from 'libp2p-pnet';
import request from 'request';
import BoltPubSubClient from './pubsub-client';

class BoltUrlError extends Error {}

class BoltIpfsError extends Error {}

const isIE = /MSIE \d|Trident.*rv:/.test(navigator.userAgent);

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

  constructor() {
    this.baseUrls = new Set();
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
  }

  addServer(s:string) {
    const { protocol, slashes, username, password, host, port } = new Url(s);
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
    result.push(host);
    result.push(port || (protocol === 'https:' ? ':443' : ':80'));
    const baseUrl = result.join('');
    const firstServer = this.baseUrls.size === 0;
    if (this.baseUrls.has(baseUrl)) {
      return;
    }
    this.addToSwarm(baseUrl);
    this.baseUrls.add(baseUrl);
    this.saveServerAddresses();
    if (firstServer) {
      this.queryForPeers(baseUrl).catch((error) => {
        console.log(`Unable to query ${baseUrl} for Bolt peers: ${error.message}`);
      });
    }
    this.readyCallback();
  }

  saveServerAddresses() {
    localStorage.setItem('BOLT_SERVER_ADDRESSES', JSON.stringify([...this.baseUrls]));
  }

  getUrl(path:string) {
    if (this.baseUrls.size === 0) {
      throw new BoltUrlError('No base URLs');
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
          reject(error);
        } else {
          try {
            resolve(JSON.parse(body));
          } catch (parseError) {
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
          reject(error);
        } else {
          try {
            resolve(JSON.parse(body));
          } catch (parseError) {
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
    console.log('Restarting IPFS');
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
    const { protocol, host, port } = new Url(baseUrl);
    const wrtcPort = port || (protocol === 'https:' ? 443 : 80);
    const wrtcProtocol = protocol === 'https:' ? 'wss' : 'ws';
    try {
      const { id, swarmKey } = await this.getSwarmSettings(baseUrl);
      if (this.swarmKey && swarmKey !== this.swarmKey) {
        // Restart if swarm keys don't match
        this.baseUrls = new Set([baseUrl]);
        this.saveServerAddresses();
        this.restartIpfs();
        return;
      }
      const multiaddr = `/dns4/${host}/tcp/${wrtcPort}/${wrtcProtocol}/ipfs/${id}`;
      console.log(`Connecting to ${multiaddr}`);
      await ipfs.swarm.connect(multiaddr);
    } catch (error) {
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
        if (swarmKey && swarmKey !== swarmSettings.swarmKey) {
          // Restart if swarm keys don't match
          this.baseUrls = new Set([baseUrl]);
          this.saveServerAddresses();
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
        pubsub: true,
        sharding: true,
        dht: true,
      },
      libp2p: {
        modules: {
          connProtector: new Protector(swarmKey),
        },
        config: {
          dht: {
            enabled: true,
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
  }

  async getPubSubClient(element: HTMLVideoElement, streamUrl:string) {
    const ipfsReady = this.ipfsReady;
    if (ipfsReady) {
      try {
        await ipfsReady;
      } catch (error) {
        console.log(`IPFS failed to start, cannot get PubSub client for ${streamUrl}`);
        throw error;
      }
    }
    const ipfs = this.ipfs;
    if (!ipfs) {
      throw new Error(`IPFS is not connected, cannot get PubSub client for ${streamUrl}`);
    }
    // const baseUrls = Array.from(this.baseUrls);
    // const baseUrl = baseUrls[Math.floor(Math.random() * baseUrls.length)];
    const baseUrl = 'http://localhost';
    return new BoltPubSubClient(element, streamUrl, baseUrl, this.ipfs);
  }
}

const bc = new BoltClient();

if (window) {
  window.boltClient = bc;
}

export default bc;
