// @flow

import expect from 'expect';
import { BoltClient } from '../src/index';

describe('Add Server', () => {
  test('Adds a server and generates a URL', async () => {
    const bc = new BoltClient();
    bc.addServer('https://example.com/something');
    expect(bc.baseUrls).toEqual(new Set(['https://example.com:443']));
    expect(bc.getUrl('test.jpg')).toEqual('https://example.com:443/test.jpg');
  });
});

