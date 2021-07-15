import boltClient from './index';
const databasePromise = new Promise((resolve, reject) => {
  const request = self.indexedDB.open('bolt', 1);

  request.onupgradeneeded = function (e) {
    try {
      e.target.result.createObjectStore('bolt', {
        keyPath: 'url'
      });
    } catch (error) {
      if (!(error.name === 'ConstraintError')) {
        throw error;
      }
    }
  };

  request.onerror = event => {
    boltClient.logger.error('Unable to open stored server database');
    console.error(event); // eslint-disable-line no-console

    reject(new Error('Unable to open stored server database'));
  };

  request.onsuccess = function (event) {
    boltClient.logger.info('Opened stored server database');
    resolve(event.target.result);
  };
});

async function getReadWriteObjectStore() {
  const db = await databasePromise;
  const transaction = db.transaction(['bolt'], 'readwrite');
  const objectStore = transaction.objectStore('bolt');

  transaction.onabort = event => {
    boltClient.logger.error('Read-write stored server transaction was aborted');
    console.error(event); // eslint-disable-line no-console
  };

  transaction.onerror = event => {
    boltClient.logger.error('Error in read-write stored server transaction');
    console.error(event); // eslint-disable-line no-console
  };

  return objectStore;
}

async function getStoredServersCallback() {
  const objectStore = await getReadWriteObjectStore();
  const request = objectStore.getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = function (event) {
      resolve(event.target.result.map(({
        url,
        priority
      }) => [url, priority]));
    };

    request.onerror = function (event) {
      boltClient.logger.error('Unable to get stored servers from indexedDB');
      console.error(event); // eslint-disable-line no-console

      reject(new Error('Unable to get stored servers from indexedDB'));
    };
  });
}

async function saveStoredServersCallback(servers) {
  const objectStore = await getReadWriteObjectStore();

  for (let i = 0; i < servers.length; i += 1) {
    if (i < servers.length - 1) {
      objectStore.put({
        url: servers[i][0],
        priority: servers[i][1]
      });
      continue;
    }

    const request = objectStore.put({
      url: servers[i][0],
      priority: servers[i][1]
    });
    await new Promise((resolve, reject) => {
      request.onsuccess = function () {
        resolve();
      };

      request.onerror = function (event) {
        boltClient.logger.error('Unable to add stored servers to indexedDB');
        console.error(event); // eslint-disable-line no-console

        reject(new Error('Unable to add stored servers to indexedDB'));
      };
    });
  }
}

async function clearStoredServersCallback() {
  const objectStore = await getReadWriteObjectStore();
  const request = objectStore.clear();
  await new Promise((resolve, reject) => {
    request.onsuccess = function () {
      resolve();
    };

    request.onerror = function (event) {
      boltClient.logger.error('Unable to clear stored servers from indexedDB');
      console.error(event); // eslint-disable-line no-console

      reject(new Error('Unable to clear stored servers to indexedDB'));
    };
  });
}

boltClient.addStoredServersCallbacks(getStoredServersCallback, saveStoredServersCallback, clearStoredServersCallback);
//# sourceMappingURL=indexeddb.js.map