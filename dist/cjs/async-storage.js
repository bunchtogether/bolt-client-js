"use strict";

var _asyncStorage = _interopRequireDefault(require("@callstack/async-storage"));

var _index = _interopRequireDefault(require("./index"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

async function getStoredServersCallback() {
  const storedServersString = await _asyncStorage.default.getItem('BOLT_SERVER_PRIORITY');

  if (typeof storedServersString !== 'string') {
    return [];
  }

  return JSON.parse(storedServersString);
}

async function saveStoredServersCallback(servers) {
  await _asyncStorage.default.setItem('BOLT_SERVER_PRIORITY', JSON.stringify(servers));
}

async function clearStoredServersCallback() {
  await _asyncStorage.default.removeItem('BOLT_SERVER_PRIORITY');
}

_index.default.addStoredServersCallbacks(getStoredServersCallback, saveStoredServersCallback, clearStoredServersCallback);
//# sourceMappingURL=async-storage.js.map