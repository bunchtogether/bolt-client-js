//      

import Url from 'url-parse';
import superagent from 'superagent';
import { debounce } from 'lodash';
import AsyncStorage from '@callstack/async-storage';

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
                   
                       
                                   
                                               
                        
                           
                                          
                                       
                                           
                       
                     

  constructor() {
    this.seedServers = new Set();
    this.preVerifiedServers = new Map();
    this.verifiedServers = new Map();
    this.ready = new Promise((resolve) => {
      this.readyCallback = () => resolve();
    });
    this.throttledSaveVerifiedServers = debounce(this.saveVerifiedServers.bind(this), 1000);
    this.loadStoredServers();
    this.isResetting = false;
    this.resetCount = 0;
  }

  getUrl(path       ) {
    if (this.verifiedServers.size > 0) {
      return `${chooseServer(this.verifiedServers)}/${path}`;
    }
    if (this.preVerifiedServers.size > 0) {
      return `${chooseServer(this.preVerifiedServers)}/${path}`;
    }
    if (this.seedServers.size > 0) {
      const urls = Array.from(this.seedServers);
      const url = urls[Math.floor(Math.random() * urls.length)];
      return `${url}/${path}`;
    }
    throw new BoltUrlError('No server URLs available');
  }

  async reset() {
    if (this.isResetting === true) {
      return;
    }
    if (this.resetCount > 5) {
      console.log(`Bolt skipping reset after ${this.resetCount} attempts`);
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
      for (const url of this.seedServers) {
        this.verifyServer(url, 0);
      }
    } catch (error) {
      console.log('Error during Bolt client reset');
      console.error(error);
    }
    this.isResetting = false;
  }

  async loadStoredServers() {
    try {
      const storedServersString = await AsyncStorage.getItem('BOLT_SERVER_PRIORITY');
      if (storedServersString) {
        const storedServers = JSON.parse(storedServersString);
        if (storedServers.length > 0) {
          console.log('Stored Bolt server addresses:');
        }
        for (const [url, priority] of storedServers) {
          console.log(`\t${url} (priority ${priority})`);
          this.verifyServer(url, priority);
        }
      }
    } catch (error) {
      console.log('Unable to parse stored Bolt server addresses');
      console.error(error);
      await AsyncStorage.removeItem('BOLT_SERVER_PRIORITY');
    }
  }

  async getSwarmSettings(url       ) {
    if (this.swarmSettings) {
      console.log('DEBUG: Got existing swarm settings');
      return this.swarmSettings;
    }
    if (this.swarmSettingsPromise) {
      console.log('DEBUG: Got swarm settings promise');
      return this.swarmSettingsPromise;
    }
    const storedSwarmSettingsString = await AsyncStorage.getItem('BOLT_SWARM_SETTINGS');
    if (storedSwarmSettingsString) {
      try {
        const swarmSettings = JSON.parse(storedSwarmSettingsString);
        this.swarmSettings = swarmSettings;
        console.log('DEBUG: Got stored BOLT_SWARM_SETTINGS');
        return swarmSettings;
      } catch (error) {
        console.log('Unable to parse stored Bolt swarm settings');
        console.error(error);
        await AsyncStorage.removeItem('BOLT_SWARM_SETTINGS');
      }
    }
    this.swarmSettingsPromise = (async () => {
      try {
        const { body: swarmSettings } = await superagent.get(`${url}/api/1.0/swarm`);
        delete this.swarmSettingsPromise;
        await AsyncStorage.setItem('BOLT_SWARM_SETTINGS', JSON.stringify(swarmSettings));
        this.swarmSettings = swarmSettings;
        console.log(`DEBUG: Got swarm settings from ${url}`);
        return swarmSettings;
      } catch (error) {
        delete this.swarmSettingsPromise;
        console.log('Unable to fetch stored Bolt swarm settings');
        console.error(error);
        throw error;
      }
    })();
    return this.swarmSettingsPromise;
  }

  async saveVerifiedServers() {
    try {
      await AsyncStorage.setItem('BOLT_SERVER_PRIORITY', JSON.stringify([...this.verifiedServers].map((x) => [x[0], x[1] === 0 ? 0 : 1])));
    } catch (error) {
      console.log('Unable to save Bolt servers to local storage');
      console.error(error);
    }
  }

  addServer(s       ) {
    try {
      const url = normalizeUrl(s);
      if (this.seedServers.has(url)) {
        return;
      }
      this.seedServers.add(url);
      console.log(`DEBUG: Added seed server ${url}`);
      this.verifyServer(url, 0);
    } catch (error) {
      console.log(`Unable to add server ${s}`);
      console.error(error);
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
    this.preVerifiedServers.set(url, priority);
    let swarmSettings;
    try {
      swarmSettings = await this.getSwarmSettings(url);
    } catch (error) {
      console.log('Unable to fetch swarm settings');
      console.error(error);
      return;
    }
    if (!swarmSettings) {
      console.log('Unable to fetch swarm settings');
      return;
    }
    if (typeof this.readyCallback === 'function') {
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
      console.log('Unable to fetch Bolt swarm settings');
      console.error(error);
      return;
    }
    if (typeof swarmKey !== 'string') {
      console.log('Bolt hostnames request did not return swarm key');
      return;
    }
    if (!Array.isArray(hostnames)) {
      console.log('Bolt hostnames request did not return hostnames array');
      return;
    }
    if (swarmSettings.swarmKey !== swarmKey) {
      console.log(`Bolt swarm key does not match for ${url}`);
      this.reset();
      return;
    }
    const storedPriority = this.preVerifiedServers.get(url) || priority;
    this.verifiedServers.set(url, storedPriority);
    this.preVerifiedServers.delete(url);
    for (const hostname of hostnames) {
      this.verifyServer(normalizeUrl(`https://${hostname}`), 2);
    }
    console.log(`DEBUG: Verified seed server ${url} with priority ${storedPriority}`);
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
