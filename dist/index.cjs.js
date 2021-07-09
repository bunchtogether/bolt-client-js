"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.BoltClient = void 0;

var _urlParse = _interopRequireDefault(require("url-parse"));

var _events = _interopRequireDefault(require("events"));

var _superagent = _interopRequireDefault(require("superagent"));

var _lodash = require("lodash");

var _asyncStorage = _interopRequireDefault(require("@callstack/async-storage"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

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
    log('blue', 'Bolt Client', value, ...args);
  },
  info: (value, ...args) => {
    log('green', 'Bolt Client', value, ...args);
  },
  warn: (value, ...args) => {
    log('orange', 'Bolt Client', value, ...args);
  },
  error: (value, ...args) => {
    log('red', 'Bolt Client', value, ...args);
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
  } = new _urlParse.default(s);
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
class BoltClient extends _events.default {
  constructor() {
    super();
    this.seedServers = new Set();
    this.storedServers = new Set();
    this.preVerifiedServers = new Map();
    this.verifiedServers = new Map();
    this.isReady = false;
    this.ready = new Promise(resolve => {
      this.readyCallback = () => resolve();
    });
    this.throttledSaveVerifiedServers = (0, _lodash.debounce)(this.saveVerifiedServers.bind(this), 1000);
    this.loadStoredServers();
    this.isResetting = false;
    this.resetCount = 0;
    this.logger = baseLogger;
    this.skipPriorityOneServers = false;
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
      await _asyncStorage.default.removeItem('BOLT_SERVER_PRIORITY');
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

  async loadStoredServers() {
    try {
      const storedServersString = await _asyncStorage.default.getItem('BOLT_SERVER_PRIORITY');

      if (storedServersString) {
        const storedServers = (0, _lodash.shuffle)(JSON.parse(storedServersString));
        storedServers.sort((x, y) => y[1] - x[1]);

        if (storedServers.length > 0) {
          this.logger.info('Stored Bolt server addresses:');
        }

        for (const [url, priority] of storedServers) {
          this.storedServers.add(url);
          this.logger.info(`\t${url} (priority ${priority})`);
        }

        for (const [url, priority] of storedServers) {
          try {
            await this.verifyServer(url, priority);
          } catch (error) {
            this.logger.error(`Unable to verify ${url} (priority ${priority})`);
            this.logger.errorStack(error);
          }
        }

        if (this.preVerifiedServers.size === 0 && !this.isReady) {
          this.reset();
        }
      }
    } catch (error) {
      this.logger.error('Unable to parse stored Bolt server addresses');
      this.logger.errorStack(error);
      await _asyncStorage.default.removeItem('BOLT_SERVER_PRIORITY');
    }
  }

  async saveVerifiedServers() {
    try {
      await _asyncStorage.default.setItem('BOLT_SERVER_PRIORITY', JSON.stringify([...this.verifiedServers].map(x => [x[0], x[1] === 0 ? 0 : 1])));
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
    this.verifyServer(url, 0).catch(error => {
      this.logger.error(`Unable to verify seed server ${url}`);
      this.logger.errorStack(error);

      if (this.preVerifiedServers.size === 0 && !this.isReady) {
        this.reset();
      }
    });
  }

  async reverifyServers() {
    this.isReady = false;
    this.ready = new Promise(resolve => {
      this.readyCallback = () => resolve();
    });
    this.verifiedServers.clear();
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
      throw new Error('Unable to re-verify servers');
    }
  }

  async verifyServer(url, priority) {
    const maxExistingPriority = Math.max(...this.verifiedServers.values());

    if (maxExistingPriority > priority) {
      this.logger.info(`Not verifying ${url}, verified server with priority ${maxExistingPriority} already exists`);
      return;
    }

    const verifiedServerPriority = this.verifiedServers.get(url);

    if (typeof verifiedServerPriority === 'number') {
      if (verifiedServerPriority < priority) {
        this.verifiedServers.set(url, priority);
        this.throttledSaveVerifiedServers();
      }

      return;
    }

    const preVerifiedServerPriority = this.preVerifiedServers.get(url);

    if (typeof preVerifiedServerPriority === 'number') {
      if (preVerifiedServerPriority < priority) {
        this.preVerifiedServers.set(url, priority);
      }

      return;
    }

    this.logger.info(`Verifying ${url}`);
    this.preVerifiedServers.set(url, priority);
    let clusterIdentifier;
    let hostnames;
    let ipRangeRoutes;

    try {
      const result = await _superagent.default.get(`${url}/api/1.0/network-map/hostnames`);
      clusterIdentifier = result.body.publicKey || result.body.swarmKey;
      hostnames = result.body.hostnames;
      ipRangeRoutes = !!result.body.ipRangeRoutes;
    } catch (error) {
      this.verifiedServers.delete(url);
      this.preVerifiedServers.delete(url);
      throw new BoltVerificationError(`Unable to fetch hostnames from ${url}`);
    }

    if (typeof clusterIdentifier !== 'string') {
      this.verifiedServers.delete(url);
      this.preVerifiedServers.delete(url);
      this.reset();
      throw new BoltVerificationError(`Hostnames request to ${url} did not return cluster identifier`);
    }

    if (!Array.isArray(hostnames)) {
      this.verifiedServers.delete(url);
      this.preVerifiedServers.delete(url);
      this.reset();
      throw new BoltVerificationError(`Hostnames request to ${url} did not return hostnames array`);
    }

    if (typeof this.clusterIdentifier === 'string') {
      if (this.clusterIdentifier !== clusterIdentifier) {
        this.verifiedServers.delete(url);
        this.preVerifiedServers.delete(url);
        this.reset();
        throw new Error(`Swarm key does not match for ${url}`);
      }
    } else {
      this.clusterIdentifier = clusterIdentifier;
    }

    const storedPriority = this.preVerifiedServers.get(url) || priority;
    this.verifiedServers.set(url, storedPriority);
    this.preVerifiedServers.delete(url);

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

    if (this.verifiedServers.size > 0 && (!this.skipPriorityOneServers || Math.max(...[...this.verifiedServers].map(x => x[1])) > 1)) {
      this.resetCount = 0;
      this.isReady = true;
      this.emit('ready');

      if (typeof this.readyCallback === 'function') {
        this.readyCallback();
        delete this.readyCallback;
      }
    }

    this.throttledSaveVerifiedServers();
  }

  startIpfs() {// Noop
  }

}

exports.BoltClient = BoltClient;
const bc = new BoltClient();

if (window) {
  window.boltClient = bc;
}

var _default = bc;
exports.default = _default;

//# sourceMappingURL=index.cjs.js.map