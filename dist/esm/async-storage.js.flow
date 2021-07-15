// @flow

import AsyncStorage from '@callstack/async-storage';
import boltClient from './index';

async function getStoredServersCallback() {
  const storedServersString = await AsyncStorage.getItem('BOLT_SERVER_PRIORITY');
  if (typeof storedServersString !== 'string') {
    return [];
  }
  return JSON.parse(storedServersString);
}

async function saveStoredServersCallback(servers: Array<[string, number]>) {
  await AsyncStorage.setItem('BOLT_SERVER_PRIORITY', JSON.stringify(servers));
}

async function clearStoredServersCallback() {
  await AsyncStorage.removeItem('BOLT_SERVER_PRIORITY');
}

boltClient.addStoredServersCallbacks(getStoredServersCallback, saveStoredServersCallback, clearStoredServersCallback);
