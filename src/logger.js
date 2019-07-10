// @flow

/* eslint-disable no-console */

import { stringify } from 'flatted';

const log = (name:string, level:string, value:any, description?: string) => {
  let color = 'gray';
  switch (level) {
    case 'debug':
      color = 'blue';
      break;
    case 'info':
      color = 'green';
      break;
    case 'warn':
      color = 'orange';
      break;
    case 'error':
      color = 'red';
      break;
    default:
      throw new Error(`Unknown level ${level}`);
  }
  if (typeof value === 'string') {
    console.log(`%c${name}: %c${value}`, `color:${color}; font-weight: bold`, `color:${color}`);
  } else {
    const sanitizedValue = JSON.parse(stringify(value));
    JSON.stringify(sanitizedValue, null, 2).split('\n').forEach((line) => {
      console.log(`%c${name}: %c${line}`, `color:${color}; font-weight: bold`, `color:${color}`);
    });
  }
  if (typeof description === 'string') {
    console.log(`%c\t${description}`, 'color:gray');
  }
};

export default (name: string) => ({
  debug: (value:any, description?: string) => {
    log(name, 'debug', value, description);
  },
  info: (value:any, description?: string) => {
    log(name, 'info', value, description);
  },
  warn: (value:any, description?: string) => {
    log(name, 'warn', value, description);
  },
  error: (value:any, description?: string) => {
    log(name, 'error', value, description);
  },
});
