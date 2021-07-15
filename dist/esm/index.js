import Url from 'url-parse';
import EventEmitter from 'events';
import { debounce, shuffle } from 'lodash';
const hasWindow = typeof window !== 'undefined';

const log = (color, name, value, ...args) => {
  const label = `%c${name}: %c${value}`;

  if (args.length === 0) {
    console.log(label, 'color:#333; font-weight: bold', `color:${color}`); // eslint-disable-line no-console

    return;
  }

  console.group(label, 'color:#333; font-weight: bold', `color:${color}`); // eslint-disable-line no-console

  for (const arg of args) {
    if (typeof arg === 'undefined') {
      continue;
    } else if (typeof arg === 'string') {
      console.log(`%c${arg}`, 'color:#666'); // eslint-disable-line no-console
    } else {
      if (arg && arg.err) {
        console.error(arg.err); // eslint-disable-line no-console
      } else if (arg && arg.error) {
        console.error(arg.error); // eslint-disable-line no-console
      }

      console.dir(arg); // eslint-disable-line no-console
    }
  }

  console.groupEnd(); // eslint-disable-line no-console
};

const baseLogger = {
  debug: (value, ...args) => {
    log('blue', hasWindow ? 'Bolt Client (Window)' : 'Bolt Client (Out of window)', value, ...args);
  },
  info: (value, ...args) => {
    log('green', hasWindow ? 'Bolt Client (Window)' : 'Bolt Client (Out of window)', value, ...args);
  },
  warn: (value, ...args) => {
    log('orange', hasWindow ? 'Bolt Client (Window)' : 'Bolt Client (Out of window)', value, ...args);
  },
  error: (value, ...args) => {
    log('red', hasWindow ? 'Bolt Client (Window)' : 'Bolt Client (Out of window)', value, ...args);
  },
  errorStack: error => {
    console.error(error); // eslint-disable-line no-console
  }
};

const any = promises => new Promise((resolve, reject) => {
  let didResolve = false;

  for (const promise of promises) {
    promise.then(() => {
      // eslint-disable-line no-loop-func
      if (didResolve) {
        return;
      }

      didResolve = true;
      resolve();
    }).catch(error => {
      // eslint-disable-line no-loop-func
      if (didResolve) {
        return;
      }

      didResolve = true;
      reject(error);
    });
  }
});

class BoltUrlError extends Error {}

class BoltVerificationError extends Error {}

const normalizeUrl = s => {
  const {
    protocol,
    slashes,
    username,
    password,
    hostname,
    port
  } = new Url(s);
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
  return result.join('');
};

const chooseServer = serverMap => {
  const servers = [...serverMap];
  const maxPriority = Math.max(...servers.map(x => x[1]));
  const maxPriorityServers = servers.filter(x => x[1] === maxPriority).map(x => x[0]);
  return maxPriorityServers[Math.floor(Math.random() * maxPriorityServers.length)];
};

/**
 * Class representing a Bolt Client
 */
export class BoltClient extends EventEmitter {
  constructor() {
    super();
    this.pauseVerification = false;
    this.seedServers = new Set();
    this.storedServers = new Set();
    this.preVerifiedServers = new Map();
    this.verifiedServers = new Map();
    this.isReady = false;
    this.ready = new Promise(resolve => {
      this.readyCallback = () => resolve();
    });
    this.throttledSaveVerifiedServers = debounce(this.saveVerifiedServers.bind(this), 1000);
    this.isResetting = false;
    this.resetCount = 0;
    this.logger = baseLogger;
    this.skipPriorityOneServers = false;
    this.getStoredServersCallbacks = [];
    this.saveStoredServersCallbacks = [];
    this.clearStoredServersCallbacks = [];
    this.ready.then(() => {
      if (this.getStoredServersCallbacks.length === 0) {
        this.logger.error('Missing stored server callbacks');
      }
    });
  }

  getUrl(path) {
    if (this.verifiedServers.size > 0) {
      if (!this.skipPriorityOneServers || Math.max(...[...this.verifiedServers].map(x => x[1])) > 1) {
        return new URL(path, chooseServer(this.verifiedServers)).toString();
      }
    }

    if (!this.skipPriorityOneServers) {
      if (this.seedServers.size > 0) {
        const urls = Array.from(this.seedServers);
        const url = urls[Math.floor(Math.random() * urls.length)];
        return new URL(path, url).toString();
      }
    }

    throw new BoltUrlError('No server URLs available');
  }

  async reset() {
    if (this.isResetting === true) {
      return;
    }

    this.resetCount += 1;

    if (this.resetCount < 6) {
      this.logger.warn(`Reset attempt ${this.resetCount}, waiting ${this.resetCount * this.resetCount} seconds`); // $FlowFixMe

      await any([new Promise(resolve => setTimeout(resolve, this.resetCount * this.resetCount * 1000)), this.ready]);
    } else {
      this.logger.warn(`Reset attempt ${this.resetCount}, waiting 30 seconds`); // $FlowFixMe

      await any([new Promise(resolve => setTimeout(resolve, 30000)), this.ready]);
    }

    try {
      this.isResetting = true;

      for (const clearStoredServersCallback of this.clearStoredServersCallbacks) {
        await clearStoredServersCallback();
      }

      delete this.clusterIdentifier;
      this.preVerifiedServers = new Map();
      this.verifiedServers = new Map();
      this.isReady = false;
      this.ready = new Promise(resolve => {
        this.readyCallback = () => resolve();
      });

      for (const url of this.seedServers) {
        try {
          await this.verifyServer(url, 0);
        } catch (error) {
          this.logger.error(`Unable to verify seed server ${url}`);
          this.logger.errorStack(error);
        }
      }
    } catch (error) {
      this.logger.error('Error during Bolt client reset');
      this.logger.errorStack(error);
    }

    this.isResetting = false;

    if (!this.isReady) {
      this.reset();
    }
  }

  addStoredServersCallbacks(getStoredServersCallback, saveStoredServersCallback, clearStoredServersCallback) {
    this.getStoredServersCallbacks.push(getStoredServersCallback);
    this.saveStoredServersCallbacks.push(saveStoredServersCallback);
    this.clearStoredServersCallbacks.push(clearStoredServersCallback);
    setTimeout(() => {
      this.loadStoredServers();
    }, 0);
  }

  async loadStoredServers() {
    if (this.pauseVerification) {
      return;
    }

    try {
      const allStoredServers = [];

      for (const getStoredServersCallback of this.getStoredServersCallbacks) {
        const storedServers = await getStoredServersCallback();

        for (const storedServer of shuffle(storedServers)) {
          allStoredServers.push(storedServer);
        }
      }

      allStoredServers.sort((x, y) => y[1] - x[1]);

      if (allStoredServers.length > 0) {
        this.logger.info('Stored Bolt server addresses:');
      }

      for (const [url, priority] of allStoredServers) {
        this.storedServers.add(url);
        this.logger.info(`\t${url} (priority ${priority})`);
      }

      let addedNewServers = false;

      for (const [url, priority] of allStoredServers) {
        try {
          const isNewServer = await this.verifyServer(url, priority);

          if (isNewServer) {
            addedNewServers = true;
          }
        } catch (error) {
          this.logger.error(`Unable to verify ${url} (priority ${priority})`);
          this.logger.errorStack(error);
        }
      }

      if (addedNewServers && this.preVerifiedServers.size === 0 && !this.isReady) {
        this.logger.error('Server not ready after loading stored servers');
        this.reset();
      }
    } catch (error) {
      this.logger.error('Unable to parse stored Bolt server addresses');
      this.logger.errorStack(error);

      for (const clearStoredServersCallback of this.clearStoredServersCallbacks) {
        await clearStoredServersCallback();
      }
    }
  }

  async saveVerifiedServers() {
    try {
      const storedServers = [...this.verifiedServers].map(x => [x[0], x[1] === 0 ? 0 : 1]);

      for (const saveStoredServersCallback of this.saveStoredServersCallbacks) {
        await saveStoredServersCallback(storedServers);
      }
    } catch (error) {
      this.logger.error('Unable to save Bolt servers to local storage');
      this.logger.errorStack(error);
    }
  }

  addServer(s) {
    const url = normalizeUrl(s);

    if (this.seedServers.has(url)) {
      return;
    }

    if (this.storedServers.has(url)) {
      return;
    }

    this.seedServers.add(url);

    if (this.pauseVerification) {
      return;
    }

    this.verifyServer(url, 0).catch(error => {
      this.logger.error(`Unable to verify seed server ${url}`);
      this.logger.errorStack(error);

      if (this.preVerifiedServers.size === 0 && !this.isReady) {
        this.reset();
      }
    });
  }

  async verifyServers() {
    this.pauseVerification = false;
    const promises = [];

    for (const url of this.seedServers) {
      promises.push(this.verifyServer(url, 0).catch(error => {
        this.logger.error(`Unable to re-verify seed server ${url}`);
        this.logger.errorStack(error);
      }));
    }

    promises.push(this.loadStoredServers());
    await Promise.all(promises);

    if (!this.isReady) {
      throw new Error('Unable to verify servers');
    }
  }

  async reverifyServers() {
    this.isReady = false;
    this.ready = new Promise(resolve => {
      this.readyCallback = () => resolve();
    });
    this.verifiedServers.clear();
    await this.verifyServers();
  }

  setVerifiedServer(url, priority) {
    this.emit('verifiedServer', url, priority);
    this.verifiedServers.set(url, priority);
    this.preVerifiedServers.delete(url);
  }

  setPreVerifiedServer(url, priority) {
    this.emit('preVerifiedServer', url, priority);
    this.preVerifiedServers.set(url, priority);
  }

  clearServer(url) {
    this.emit('clearServer', url);
    this.verifiedServers.delete(url);
    this.preVerifiedServers.delete(url);
  }

  checkIsReady() {
    if (this.verifiedServers.size > 0 && (!this.skipPriorityOneServers || Math.max(...[...this.verifiedServers].map(x => x[1])) > 1)) {
      this.resetCount = 0;

      if (!this.isReady) {
        this.isReady = true;
        this.emit('ready');

        if (typeof this.readyCallback === 'function') {
          this.readyCallback();
          delete this.readyCallback;
        }
      }
    }
  }

  async verifyServer(url, priority) {
    const maxExistingPriority = Math.max(...this.verifiedServers.values());

    if (maxExistingPriority > priority) {
      this.logger.info(`Not verifying ${url}, verified server with priority ${maxExistingPriority} already exists`);
      return false;
    }

    const verifiedServerPriority = this.verifiedServers.get(url);

    if (typeof verifiedServerPriority === 'number') {
      if (verifiedServerPriority < priority) {
        this.setVerifiedServer(url, priority);
        this.throttledSaveVerifiedServers();
      }

      return false;
    }

    const preVerifiedServerPriority = this.preVerifiedServers.get(url);

    if (typeof preVerifiedServerPriority === 'number') {
      if (preVerifiedServerPriority < priority) {
        this.setPreVerifiedServer(url, priority);
      }

      return false;
    }

    this.logger.info(`Verifying ${url}`);
    this.setPreVerifiedServer(url, priority);
    let clusterIdentifier;
    let hostnames;
    let ipRangeRoutes;

    try {
      const response = await fetch(`${url}/api/1.0/network-map/hostnames`);
      const body = await response.json();
      clusterIdentifier = body.publicKey || body.swarmKey;
      hostnames = body.hostnames;
      ipRangeRoutes = !!body.ipRangeRoutes;
    } catch (error) {
      this.clearServer(url);
      throw new BoltVerificationError(`Unable to fetch hostnames from ${url}`);
    }

    if (typeof clusterIdentifier !== 'string') {
      this.clearServer(url);
      this.reset();
      throw new BoltVerificationError(`Hostnames request to ${url} did not return cluster identifier`);
    }

    if (!Array.isArray(hostnames)) {
      this.clearServer(url);
      this.reset();
      throw new BoltVerificationError(`Hostnames request to ${url} did not return hostnames array`);
    }

    if (typeof this.clusterIdentifier === 'string') {
      if (this.clusterIdentifier !== clusterIdentifier) {
        this.clearServer(url);
        this.reset();
        throw new Error(`Swarm key does not match for ${url}`);
      }
    } else {
      this.clusterIdentifier = clusterIdentifier;
    }

    const storedPriority = this.preVerifiedServers.get(url) || priority;
    this.setVerifiedServer(url, storedPriority);

    if (ipRangeRoutes || hostnames && hostnames.length > 0) {
      this.skipPriorityOneServers = true;
    }

    for (const hostname of hostnames) {
      try {
        await this.verifyServer(normalizeUrl(`https://${hostname}`), 2);
      } catch (error) {
        this.logger.error(`Unable to verify https://${hostname}`);
        this.logger.errorStack(error);
      }
    }

    this.checkIsReady();
    this.throttledSaveVerifiedServers();
    return true;
  }

  startIpfs() {// Noop
  }

}
const bc = new BoltClient();

if (hasWindow) {
  window.boltClient = bc;
}

export default bc;
//# sourceMappingURL=index.js.map