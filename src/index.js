// @flow

import Protector from 'libp2p-pnet';
import IPFS from 'ipfs';


/**
 * Class representing a Bolt Client
 */
class Client extends IPFS {
  constructor(protocol: string, host: string, port: number, swarmKey: string, bootstrap?: Array<string> = []) {
    const config = {
      repo: 'ipfs',
      EXPERIMENTAL: {
        pubsub: true,
      },
      libp2p: {
        modules: {
          connProtector: new Protector(swarmKey)
        }
      },
      config: {
        Addresses: {
          Swarm: [
            `/dns4/${host}/tcp/${port}/${protocol}/p2p-webrtc-star`,
          ],
        },
        Bootstrap: bootstrap,
      },
    };
    super(config);
  }
}

export default Client;
