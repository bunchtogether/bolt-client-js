//      

                                       

import Protector from 'libp2p-pnet';
import IpfsObservedRemoveMap from 'ipfs-observed-remove/dist/map';
import Stream from 'readable-stream';
import streamToString from 'stream-to-string';
import pump from 'pump';
import URL from 'url-parse';
import { Parser } from 'm3u8-parser';
import request from 'request';
import multibase from 'multibase';
import LruCache from 'lru-cache';

const enablePrefetchCache = new LruCache({ max: 500, maxAge: 30000 });
const disablePrefetchCache = new LruCache({ max: 500, maxAge: 30000 });

const isIE = /MSIE \d|Trident.*rv:/.test(navigator.userAgent);

const enablePrefetch = (path) => {
  enablePrefetchCache.set(path, true);
};

const disablePrefetch = (path) => {
  disablePrefetchCache.set(path, true);
};

const shouldPrefetch = (path       ) => enablePrefetchCache.has(path) && !disablePrefetchCache.has(path);

const timeCache = new LruCache({ max: 500 });
const logTime = (message        , path        ) => {
  if (path.indexOf('m3u8') !== -1) {
    return;
  }
  let start = timeCache.get(path);
  if (!start) {
    start = Date.now();
    timeCache.set(path, start);
    console.log(path.split('/').pop(), message, start);
  } else {
    console.log(path.split('/').pop(), message, start, Date.now(), `+${Date.now() - start}`);
    timeCache.del(path);
  }
};

const mergeUint8Arrays = (arrays) => {
  let length = 0;
  arrays.forEach((item) => {
    length += item.length;
  });
  const merged = new Uint8Array(length);
  let offset = 0;
  arrays.forEach((item) => {
    merged.set(item, offset);
    offset += item.length;
  });
  return merged;
};

const { performance } = window;

const isFqdmRegex = /^(?!:\/\/)(?!.{256,})(([a-z0-9][a-z0-9_-]*?\.)+?[a-z]{2,16}?)$/i;

const isFqdm = (hostname        ) => isFqdmRegex.test(hostname);

export class FilesError extends Error {
              
  constructor(message       , code       ) {
    super(message);
    this.code = code;
  }
}

                            
                 
               
               
                   
                    
                  
                  
  

const ipfsLoadPromise = (async () => {
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
})();


class BoltLoader {
                 
                     
                 
              

  static boltClient = {
    getProxyPath: (path       ) => { // eslint-disable-line no-unused-vars
      throw new Error('Not implemented');
    },
    getProxyUrl: (urlString       ) => { // eslint-disable-line no-unused-vars
      throw new Error('Not implemented');
    },
    getStream: (path       ) => { // eslint-disable-line no-unused-vars
      throw new Error('Not implemented');
    },
    parseM3u8Stream: (file          ) => { // eslint-disable-line no-unused-vars
      throw new Error('Not implemented');
    },
  };

  constructor(config       ) {
    this.config = config;
  }

  load(context                                                   , config                  , callbacks                                                                                     ) {
    const boltClient = this.constructor.boltClient;
    const start = Date.now();
    const stats        = {
      trequest: performance.now(),
      loaded: 0,
      bw: 0,
      retry: 0,
    };
    const { onSuccess, onError, onTimeout, onProgress } = callbacks;
    const { url, responseType } = context;
    this.url = url;
    const proxyPath = boltClient.getProxyPath(url);
    const proxyUrl = boltClient.getProxyUrl(url);
    const chunks = [];
    const file = boltClient.getStream(proxyPath);
    this.file = file;
    if (context.type === 'level') {
      enablePrefetch(proxyPath);
      boltClient.parseM3u8Stream(file);
    }
    const timeout = setTimeout(() => {
      file.removeListener('end', handleEnd);
      file.removeListener('data', handleData);
      file.removeListener('error', handleError);
      onTimeout(stats, context, null);
    }, config.timeout);
    this.timeout = timeout;
    const handleData = (buffer       ) => {
      const seconds = (Date.now() - start) / 1000;
      if (!stats.tfirst) {
        stats.tfirst = performance.now();
      }
      stats.loaded += buffer.length;
      stats.bw = stats.loaded * 8 / seconds;
      if (onProgress) {
        onProgress(stats, context, null, boltClient);
      }
      chunks.push(buffer);
    };
    const handleEnd = () => {
      clearTimeout(timeout);
      file.removeListener('end', handleEnd);
      file.removeListener('data', handleData);
      file.removeListener('error', handleError);
      const arrayBuffer = mergeUint8Arrays(chunks);
      stats.total = arrayBuffer.length;
      if (responseType === 'arraybuffer') {
        onSuccess({ url: proxyUrl, data: arrayBuffer }, stats, context, boltClient);
      } else {
        onSuccess({ url: proxyUrl, data: Buffer.from(arrayBuffer).toString('utf8') }, stats, context, boltClient);
      }
      delete this.file;
    };
    const handleError = (error) => {
      clearTimeout(timeout);
      file.removeListener('end', handleEnd);
      file.removeListener('data', handleData);
      file.removeListener('error', handleError);
      console.log(`Error loading ${url}:`);
      console.error(error);
      onError({ code: 500, text: error.message }, context);
      delete this.file;
    };
    file.on('data', handleData);
    file.on('end', handleEnd);
    file.on('error', handleError);
  }

  abort() {
    clearTimeout(this.timeout);
    if (this.file) {
      this.file.removeAllListeners();
      delete this.file;
    }
  }
  destroy() {
    delete this.config;
    this.abort();
  }
}

const PLAYLIST_MIMETYPES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl']);

const isPlaylistMimetype = (mimetype        ) => PLAYLIST_MIMETYPES.has(mimetype.toLowerCase());

/**
 * Class representing a Bolt Client
 */
class BoltClient {
               
                                                             
                
                   
               
               
                            
                     
                    
                    
                   
                    
               
                                                 
                           

  constructor() {
    this.proxyBytes = 0;
    this.ipfsBytes = 0;
    this.proxyTime = 0;
    this.ipfsTime = 0;
    this.playlistUpdateTimeouts = new Map();
    let activePeerCount = 0;
    setInterval(() => {
      if (this.proxyBytes > 0 || this.ipfsBytes > 0 || this.proxyTime > 0 || this.ipfsTime > 0) {
        console.log('Stats:');
      }
      if (this.proxyBytes > 0 || this.ipfsBytes > 0) {
        const percentage = Math.round(10000 * this.ipfsBytes / (this.proxyBytes + this.ipfsBytes)) / 100;
        console.log(`\t${percentage}% P2P (bytes)`);
      }
      if (this.proxyTime > 0) {
        const kbps = Math.round(10 * (this.proxyBytes * 8) / (1024 * this.proxyTime / 1000)) / 10;
        console.log(`\tProxy speed: ${kbps} Kbs`);
      }
      if (this.ipfsTime > 0) {
        const kbps = Math.round(10 * (this.ipfsBytes * 8) / (1024 * this.ipfsTime / 1000)) / 10;
        console.log(`\tP2P speed: ${kbps} Kbs`);
      }
      if (this.ipfs) {
        this.ipfs.swarm.peers().then((peerInfos) => {
          if (peerInfos.length !== activePeerCount) {
            activePeerCount = peerInfos.length;
            console.log(`${activePeerCount} peers`);
          }
        }).catch((error) => {
          console.log('Unable to get swarm peers');
          console.error(error);
        });
      }
    }, 10000);
    const storedServerSettings = this.getStoredServerSettings();
    if (storedServerSettings.host && storedServerSettings.protocol && storedServerSettings.port) {
      this.setServer(storedServerSettings.protocol, storedServerSettings.host, storedServerSettings.port);
    }
  }

  get hlsJsLoader() {
    const boltClient = this;
    class C extends BoltLoader {
      static boltClient = boltClient;
    }
    return C;
  }

  getStoredServerSettings() {
    const storedServerSettingsString = localStorage.getItem('BOLT_SERVER_SETTINGS');
    if (!storedServerSettingsString) {
      return {};
    }
    try {
      return JSON.parse(storedServerSettingsString);
    } catch (error) {
      console.log('Unable to parse stored server settings');
      console.error(error);
    }
    localStorage.removeItem('BOLT_SERVER_SETTINGS');
    localStorage.removeItem('BOLT_SWARM_SETTINGS');
    return {};
  }

  getStoredSwarmSettings() {
    const storedSwarmSettingsString = localStorage.getItem('BOLT_SWARM_SETTINGS');
    if (!storedSwarmSettingsString) {
      return {};
    }
    try {
      return JSON.parse(storedSwarmSettingsString);
    } catch (error) {
      console.log('Unable to parse stored swarm settings');
      console.error(error);
    }
    localStorage.removeItem('BOLT_SERVER_SETTINGS');
    localStorage.removeItem('BOLT_SWARM_SETTINGS');
    return {};
  }

  setServer(protocol        , host        , port        ) {
    this.protocol = protocol;
    this.host = host;
    this.port = port;
    const storedServerSettings = this.getStoredServerSettings();
    if (storedServerSettings.protocol !== protocol || storedServerSettings.host !== host || storedServerSettings.port !== port) {
      localStorage.setItem('BOLT_SERVER_SETTINGS', JSON.stringify({ protocol, host, port }));
      this.restartIpfs();
    }
  }

  base32Hostname(id        ) {
    const base32Id = multibase.encode('base32', multibase.decode(`z${id}`)).slice(1).toString();
    return `p-${base32Id}.${this.host}`;
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

  async _startIpfs() {
    if (this.ipfs) {
      throw new Error('IPFS already started');
    }
    const IPFS = await ipfsLoadPromise;
    let { id, swarmKey, peerIds, clusterId } = this.getStoredSwarmSettings();
    if (!id || !swarmKey || !peerIds || !clusterId) {
      const swarmSettings = await this.getJson('/api/1.0/swarm');
      id = swarmSettings.id;
      swarmKey = swarmSettings.swarmKey;
      peerIds = swarmSettings.peerIds;
      clusterId = swarmSettings.clusterId;
      localStorage.setItem('BOLT_SWARM_SETTINGS', JSON.stringify({ id, swarmKey, peerIds, clusterId }));
    } else {
      console.log('Using saved swarm settings');
      this.getJson('/api/1.0/swarm').then(async (swarmSettings) => {
        if (swarmSettings.id !== id || swarmSettings.swarmKey !== swarmKey || swarmSettings.clusterId !== clusterId) {
          localStorage.setItem('BOLT_SWARM_SETTINGS', JSON.stringify(swarmSettings));
          this.restartIpfs();
        }
        if (this.ipfs && isFqdm(this.host)) {
          for (const peerId of swarmSettings.peerIds) {
            this.ipfs.swarm.connect(`/dns4/${this.base32Hostname(peerId)}/tcp/${this.port}/${wrtcProtocol}/ipfs/${peerId}`).catch((error) => {
              console.log(`Unable to connect to swarm peer ${peerId}`);
              console.error(error);
            });
          }
        }
      }).catch((error) => {
        console.log('Unable to get swarm settings');
        console.error(error);
      });
    }
    this.clusterId = clusterId;
    const wrtcProtocol = this.protocol === 'https' ? 'wss' : 'ws';
    const swarmAddresses = [];
    const bootstrap = [];
    if (isFqdm(this.host)) {
      swarmAddresses.push(`/dns4/${this.base32Hostname(id)}/tcp/${this.port}/${wrtcProtocol}/p2p-webrtc-star`);
      bootstrap.push(`/dns4/${this.base32Hostname(id)}/tcp/${this.port}/${wrtcProtocol}/ipfs/${id}`);
      for (const peerId of peerIds) {
        bootstrap.push(`/dns4/${this.base32Hostname(peerId)}/tcp/${this.port}/${wrtcProtocol}/ipfs/${peerId}`);
      }
    }
    swarmAddresses.push(`/dns4/${this.host}/tcp/${this.port}/${wrtcProtocol}/p2p-webrtc-star`);
    bootstrap.push(`/dns4/${this.host}/tcp/${this.port}/${wrtcProtocol}/ipfs/${id}`);
    const config = {
      repo: 'bolt',
      preload: {
        enabled: false,
      },
      relay: {
        enabled: true,
        hop: {
          enabled: true,
          active: true,
        },
      },
      EXPERIMENTAL: {
        pubsub: true,
        sharding: true,
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
    this.metadataOrMap = new IpfsObservedRemoveMap(ipfs, `${clusterId}:files`, [], { disableSync: true });
    this.metadataOrMap.on('set', (path, { hash, mimetype }) => {
      logTime('METADATA', path);
      // if (shouldPrefetch(path)) {
      //  const stream = this.ipfs.getReadableStream(hash);
      //  if (isPlaylistMimetype(mimetype)) {
      //    const file = new Stream.PassThrough({ objectMode: true });
      //    stream.on('error', (error) => {
      //      console.log(`Unable to get stream for ${path}:`);
      //      console.error(error);
      //      file.destroy(error);
      //    });
      //    stream.on('data', ({ content }) => {
      //      if (file.writable) {
      //        pump(content, file);
      //      }
      //      stream.end();
      //    });
      //    this.parseM3u8Stream(file);
      //  }
      // }
    });
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

  async parseM3u8Stream(stream          ) {
    const manifest = await streamToString(stream);
    const parser = new Parser();
    parser.push(manifest);
    parser.end();
    if (parser && parser.manifest && parser.manifest.segments) {
      for (const segment of parser.manifest.segments) {
        enablePrefetch(segment.uri.slice(1));
      }
    }
  }

  getProxyUrl(urlString       ) {
    const proxyPath = this.getProxyPath(urlString);
    return `${this.protocol}://${this.host}:${this.port}/${proxyPath}`;
  }

  getProxyPath(urlString       ) {
    const url = new URL(urlString);
    if (url.pathname.indexOf('origin/') !== -1) {
      return `${url.pathname.slice(1)}${url.query ? `?${url.query}` : ''}`;
    }
    return `origin/${url.hostname}${url.pathname}${url.query ? `?${url.query}` : ''}`;
  }

  getJson(path       )                 {
    return new Promise((resolve, reject) => {
      request.get(`${this.protocol}://${this.host}:${this.port}${path}`, (error, response, body) => {
        if (error) {
          reject(error);
        } else {
          resolve(JSON.parse(body));
        }
      });
    });
  }

  getProxyStream(path       )          {
    const req = request.get(`${this.protocol}://${this.host}:${this.port}/${path}`);
    const file = new Stream.PassThrough({ objectMode: true });
    const start = Date.now();
    pump(req, file);
    file.on('end', () => {
      this.proxyTime += Date.now() - start;
    });
    file.on('data', (data           ) => {
      this.proxyBytes += data.length;
    });
    req.on('response', (response) => {
      if (isPlaylistMimetype(response.caseless.get('content-type'))) {
        disablePrefetch(path);
      }
    });
    if (this.ipfs) {
      const ingest = new Stream.PassThrough({ objectMode: true });
      pump(req, ingest);
      this.ipfs.add({
        path: null,
        content: ingest,
      }, {
        wrapWithDirectory: false,
        recursive: false,
        pin: false,
      }, (error) => {
        if (error) {
          console.log(`Unable to ingest ${path}`);
          console.error(error);
        }
      });
    }
    return file;
  }

  getStream(path       )          {
    if (!this.metadataOrMap) {
      logTime('MISS:MAP', path);
      if (path.indexOf('origin/') === 0) {
        return this.getProxyStream(path);
      }
      throw new FilesError(`Unable to load ${path} metadata map does not exist`, 404);
    }
    const metadata = this.metadataOrMap.get(path);
    if (!metadata) {
      logTime('MISS:METADATA', path);
      if (path.indexOf('origin/') === 0) {
        return this.getProxyStream(path);
      }
      throw new FilesError(`Unable to find ${path}`, 404);
    }
    if (!isPlaylistMimetype(metadata.mimetype)) {
      disablePrefetch(path);
    }
    const expires = metadata.expires;
    if (expires) {
      if (new Date(expires) < new Date()) {
        logTime('MISS:EXPIRED', path);
        if (path.indexOf('origin/') === 0) {
          return this.getProxyStream(path);
        }
        throw new FilesError(`Expired ${path}`, 404);
      }
    }
    logTime('HIT', path);
    const stream = this.ipfs.getReadableStream(metadata.hash);
    const file = new Stream.PassThrough({ objectMode: true });
    const start = Date.now();
    file.on('end', () => {
      this.ipfsTime += Date.now() - start;
    });
    file.on('data', (data           ) => {
      this.ipfsBytes += data.length;
    });
    stream.on('error', (error) => {
      console.log(`Unable to get stream for ${path}:`);
      console.error(error);
      file.destroy(error);
    });
    stream.on('data', ({ content }) => {
      pump(content, file);
      stream.end();
    });
    return file;
  }
}

export default new BoltClient();
