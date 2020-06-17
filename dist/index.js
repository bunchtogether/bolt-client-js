//      

import Url from 'url-parse';
import superagent from 'superagent';
import { debounce } from 'lodash';
import AsyncStorage from '@callstack/async-storage';
import baseLogger from './logger';

class BoltUrlError extends Error {}

const normalizeUrl = (s       ) => {
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
  return result.join('');
};

const chooseServer = (serverMap                    ) => {
  const servers = [...serverMap];
  const maxPriority = Math.max(...servers.map((x) => x[1]));
  const maxPriorityServers = servers.filter((x) => x[1] === maxPriority).map((x) => x[0]);
  return maxPriorityServers[Math.floor(Math.random() * maxPriorityServers.length)];
};

               
                                           
                                          
                                          
                                           
                                                
  

/**
 * Class representing a Bolt Client
 */
export class BoltClient {
                           
                               
                                           
                                                       
                                
                                   
                                                  
                                               
                                                   
                               
                             
                           
                         

  constructor(logger          = baseLogger) {
    this.seedServers = new Set();
    this.preVerifiedServers = new Map();
    this.verifiedServers = new Map();
    this.isReady = false;
    this.ready = new Promise((resolve) => {
      this.readyCallback = () => resolve();
    });
    this.throttledSaveVerifiedServers = debounce(this.saveVerifiedServers.bind(this), 1000);
    this.loadStoredServers();
    this.isResetting = false;
    this.resetCount = 0;
    this.logger = logger;
  }

  getUrl(path       ) {
    if (this.verifiedServers.size > 0) {
      return new URL(path, chooseServer(this.verifiedServers)).toString();
    }
    if (this.preVerifiedServers.size > 0) {
      return new URL(path, chooseServer(this.preVerifiedServers)).toString();
    }
    if (this.seedServers.size > 0) {
      const urls = Array.from(this.seedServers);
      const url = urls[Math.floor(Math.random() * urls.length)];
      return new URL(path, url).toString();
    }
    throw new BoltUrlError('No server URLs available');
  }

  async reset() {
    if (this.isResetting === true) {
      return;
    }
    if (this.resetCount > 5) {
      this.logger.warn(`Bolt skipping reset after ${this.resetCount} attempts`);
      return;
    }
    try {
      this.isResetting = true;
      this.resetCount += 1;
      if (this.swarmSettingsPromise) {
        await this.swarmSettingsPromise;
      }
      await AsyncStorage.removeItem('BOLT_SWARM_SETTINGS');
      await AsyncStorage.removeItem('BOLT_SERVER_PRIORITY');
      delete this.swarmSettings;
      delete this.swarmSettingsPromise;
      this.preVerifiedServers = new Map();
      this.verifiedServers = new Map();
      this.isReady = false;
      this.ready = new Promise((resolve) => {
        this.readyCallback = () => resolve();
      });
      for (const url of this.seedServers) {
        this.verifyServer(url, 0);
      }
    } catch (error) {
      this.logger.error('Error during Bolt client reset');
      this.logger.errorStack(error);
    }
    this.isResetting = false;
  }

  async loadStoredServers() {
    try {
      const storedServersString = await AsyncStorage.getItem('BOLT_SERVER_PRIORITY');
      if (storedServersString) {
        const storedServers = JSON.parse(storedServersString);
        if (storedServers.length > 0) {
          this.logger.info('Stored Bolt server addresses:');
        }
        for (const [url, priority] of storedServers) {
          this.logger.info(`\t${url} (priority ${priority})`);
          this.verifyServer(url, priority);
        }
      }
    } catch (error) {
      this.logger.error('Unable to parse stored Bolt server addresses');
      this.logger.errorStack(error);
      await AsyncStorage.removeItem('BOLT_SERVER_PRIORITY');
    }
  }

  async getSwarmSettings(url       ) {
    if (this.swarmSettings) {
      return this.swarmSettings;
    }
    if (this.swarmSettingsPromise) {
      return this.swarmSettingsPromise;
    }
    const storedSwarmSettingsString = await AsyncStorage.getItem('BOLT_SWARM_SETTINGS');
    if (storedSwarmSettingsString) {
      try {
        const swarmSettings = JSON.parse(storedSwarmSettingsString);
        this.swarmSettings = swarmSettings;
        return swarmSettings;
      } catch (error) {
        this.logger.error('Unable to parse stored Bolt swarm settings');
        this.logger.errorStack(error);
        await AsyncStorage.removeItem('BOLT_SWARM_SETTINGS');
      }
    }
    this.swarmSettingsPromise = (async () => {
      try {
        const { body: swarmSettings } = await superagent.get(`${url}/api/1.0/swarm`);
        delete this.swarmSettingsPromise;
        await AsyncStorage.setItem('BOLT_SWARM_SETTINGS', JSON.stringify(swarmSettings));
        this.swarmSettings = swarmSettings;
        return swarmSettings;
      } catch (error) {
        delete this.swarmSettingsPromise;
        this.logger.error('Unable to fetch stored Bolt swarm settings');
        this.logger.errorStack(error);
        throw error;
      }
    })();
    return this.swarmSettingsPromise;
  }

  async saveVerifiedServers() {
    try {
      await AsyncStorage.setItem('BOLT_SERVER_PRIORITY', JSON.stringify([...this.verifiedServers].map((x) => [x[0], x[1] === 0 ? 0 : 1])));
    } catch (error) {
      this.logger.error('Unable to save Bolt servers to local storage');
      this.logger.errorStack(error);
    }
  }

  addServer(s       ) {
    try {
      const url = normalizeUrl(s);
      if (this.seedServers.has(url)) {
        return;
      }
      this.seedServers.add(url);
      this.verifyServer(url, 0);
    } catch (error) {
      this.logger.error(`Unable to add server ${s}`);
      this.logger.errorStack(error);
    }
  }

  async verifyServer(url       , priority       ) {
    const verifiedServerPriority = this.verifiedServers.get(url);
    if (typeof verifiedServerPriority === 'number') {
      if (verifiedServerPriority < priority) {
        this.verifiedServers.set(url, priority);
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
    let swarmSettings;
    try {
      swarmSettings = await this.getSwarmSettings(url);
    } catch (error) {
      this.logger.error('Unable to fetch swarm settings');
      this.logger.errorStack(error);
      return;
    }
    if (!swarmSettings) {
      this.logger.error('Unable to fetch swarm settings');
      return;
    }
    if (typeof this.readyCallback === 'function') {
      this.isReady = true;
      this.readyCallback();
      delete this.readyCallback;
    }
    if (priority === 0) {
      this.verifiedServers.set(url, 0);
      this.throttledSaveVerifiedServers();
    }
    let swarmKey;
    let hostnames;
    try {
      const result = await superagent.get(`${url}/api/1.0/network-map/hostnames`);
      swarmKey = result.body.swarmKey;
      hostnames = result.body.hostnames;
    } catch (error) {
      this.verifiedServers.delete(url);
      this.preVerifiedServers.delete(url);
      this.logger.error('Unable to fetch Bolt swarm settings');
      this.logger.errorStack(error);
      return;
    }
    if (typeof swarmKey !== 'string') {
      this.logger.error('Bolt hostnames request did not return swarm key');
      return;
    }
    if (!Array.isArray(hostnames)) {
      this.logger.error('Bolt hostnames request did not return hostnames array');
      return;
    }
    if (swarmSettings.swarmKey !== swarmKey) {
      this.logger.error(`Bolt swarm key does not match for ${url}`);
      this.reset();
      return;
    }
    const storedPriority = this.preVerifiedServers.get(url) || priority;
    this.verifiedServers.set(url, storedPriority);
    this.preVerifiedServers.delete(url);
    for (const hostname of hostnames) {
      this.verifyServer(normalizeUrl(`https://${hostname}`), 2);
    }
    this.throttledSaveVerifiedServers();
  }

  startIpfs() {
    // Noop
  }
}

const bc = new BoltClient();

if (window) {
  window.boltClient = bc;
}

export default bc;
