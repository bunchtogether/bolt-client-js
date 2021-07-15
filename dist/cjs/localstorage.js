"use strict";

var _index = _interopRequireDefault(require("./index"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

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

_index.default.addStoredServersCallbacks(getStoredServersCallback, saveStoredServersCallback, clearStoredServersCallback);
//# sourceMappingURL=localstorage.js.map