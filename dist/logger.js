//      

const log = (color       , name       , value                , ...args           ) => {
  const label = `%c${name}: %c${value}`;
  if (args.length === 0) {
    console.log(label, 'color:#333; font-weight: bold', `color:${color}`);
    return;
  }
  console.group(label, 'color:#333; font-weight: bold', `color:${color}`);
  for (const arg of args) {
    if (typeof arg === 'undefined') {
      continue;
    } else if (typeof arg === 'string') {
      console.log(`%c${arg}`, 'color:#666');
    } else {
      if (arg && arg.err) {
        console.error(arg.err);
      } else if (arg && arg.error) {
        console.error(arg.error);
      }
      console.dir(arg);
    }
  }
  console.groupEnd();
};

export default {
  debug: (value                , ...args           ) => {
    log('blue', 'Bolt', value, ...args);
  },
  info: (value                , ...args           ) => {
    log('green', 'Bolt', value, ...args);
  },
  warn: (value                , ...args           ) => {
    log('orange', 'Bolt', value, ...args);
  },
  error: (value                , ...args           ) => {
    log('red', 'Bolt', value, ...args);
  },
  errorStack: (error                   ) => {
    console.error(error);
  },
};
