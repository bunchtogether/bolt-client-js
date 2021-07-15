import boltClient from './index';

function getStoredServersCallback() {
  const storedServersString = localStorage.getItem('BOLT_SERVER_PRIORITY');

  if (typeof storedServersString !== 'string') {
    return [];
  }

  return JSON.parse(storedServersString);
}

function saveStoredServersCallback(servers) {
  localStorage.setItem('BOLT_SERVER_PRIORITY', JSON.stringify(servers));
}

function clearStoredServersCallback() {
  localStorage.removeItem('BOLT_SERVER_PRIORITY');
}

boltClient.addStoredServersCallbacks(getStoredServersCallback, saveStoredServersCallback, clearStoredServersCallback);
//# sourceMappingURL=localstorage.js.map